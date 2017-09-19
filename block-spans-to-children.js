#!/usr/bin/env node

/* eslint-disable no-console, no-sync, no-process-exit */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const createClient = require('@sanity/client')
const inquirer = require('inquirer')
const ConfigStore = require('configstore')
const get = require('lodash/get')
const isPlainObject = require('lodash/isPlainObject')
const reduce = require('json-reduce').default

const knownSpanKeys = ['_type', '_key', 'text']
const keysSeen = new Set()
let tieBreaker = 0

let sanityConfig
try {
  sanityConfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'sanity.json')).toString()
  )
} catch (error) {
  console.error(
    'Could not read sanity config from current working directory. Make sure you have a sanity.json.\nError was %s',
    error.message
  )
  process.exit(1)
}

function fetchAllDocuments(client) {
  return client.fetch('*[!(_id in path("_.**"))][0...1000000]')
}

function generatePatchesForDocument(document) {
  const result = createPatchesForDocument(document)
  if (result.unset.length === 0) {
    return null
  }

  return result
}

function commit(patches, client) {
  return Promise.all(
    patches.map(({id, set, unset}) =>
      client.patch(id, {set, unset}).commit({visibility: 'async'})
    )
  )
}

function promptBackup() {
  return inquirer.prompt([
    {
      name: 'continue',
      type: 'confirm',
      default: false,
      message: `Before doing this migration, make sure you have a backup handy.\n  "sanity dataset export <dataset> <somefile.ndjson>" is an easy way to do this.\n\nWould you like to perform the migration on dataset "${sanityConfig
        .api.dataset}"?`
    }
  ])
}

function confirm(patches) {
  if (patches.length === 0) {
    return {noop: true}
  }

  const docIds = patches.map(doc => doc.id)

  return inquirer
    .prompt([
      {
        name: 'continue',
        type: 'confirm',
        default: false,
        message: `The following documents will be updated:\n \n${docIds.join(
          '\n'
        )}\n\nWould you like to continue?`
      }
    ])
    .then(result => Object.assign({}, result, {patches}))
}

function getToken() {
  const authToken = new ConfigStore('sanity', {}, {globalConfigPath: true}).get(
    'authToken'
  )

  if (authToken) {
    return Promise.resolve(authToken)
  }

  return inquirer
    .prompt([
      {
        name: 'token',
        type: 'password',
        message: `Please enter a token with write access on project ${sanityConfig
          .api.projectId}`
      }
    ])
    .then(result => result.token)
}

function getClient() {
  return getToken().then(token =>
    createClient({
      projectId: sanityConfig.api.projectId,
      dataset: sanityConfig.api.dataset,
      useCdn: false,
      token
    })
  )
}

function createPatchesForDocument(doc) {
  return reduce(
    doc,
    (acc, value, keyPath) => {
      const key = keyPath[keyPath.length - 1]
      const parentPath = keyPath.slice(0, -1)
      const parent = get(doc, parentPath)

      if (key === '_type' && value === 'block' && parent.spans) {
        const childPath = serializePath(parentPath.concat('children'))
        const markDefsPath = serializePath(parentPath.concat('markDefs'))
        const spansPath = serializePath(parentPath.concat('spans'))
        const {children, markDefs} = migrateSpans(parent.spans)

        acc.set[childPath] = children
        acc.set[markDefsPath] = markDefs
        acc.unset.push(spansPath)
      }

      return acc
    },
    {id: doc._id, set: {}, unset: []}
  )
}

function serializePath(path) {
  return path.reduce((target, part, i) => {
    const isIndex = typeof part === 'number'
    const seperator = i === 0 ? '' : '.'
    const add = isIndex ? `[${part}]` : `${seperator}${part}`
    return `${target}${add}`
  }, '')
}

function migrateSpans(spans) {
  const markDefs = []
  const children = spans
    .map(span => {
      return Object.keys(span).reduce((child, key) => {
        if (key === 'marks') {
          return child
        }

        const knownKey = knownSpanKeys.includes(key)
        if (knownKey || !isPlainObject(span[key])) {
          child[key] = span[key]
          return child
        }

        // Only include "marks" that actually has content
        const hasContent = Object.keys(span[key]).length > 0
        if (!hasContent) {
          return child
        }

        // Treat unknown keys as "custom" marks
        const markKey = generateKey(span[key])
        child.marks = [markKey].concat(span.marks)

        if (!markDefs.find(item => item._key === markKey)) {
          markDefs.push(
            Object.assign({}, span[key], {
              _type: key,
              _key: markKey
            })
          )
        }

        return child
      }, {marks: span.marks || []})
    })
    .map(child => {
      if (!child._key) {
        child._key = generateKey(child, true)
      }

      return child
    })

  return {children, markDefs}
}

function generateKey(item, unique) {
  const base = crypto
    .createHash('sha1')
    .update(JSON.stringify(item))
    .digest('hex')
    .slice(0, 8)

  if (keysSeen.has(base)) {
    return `${base}${++tieBreaker}`
  }

  keysSeen.add(base)
  return base
}

function run() {
  promptBackup()
    .then(result => {
      if (!result.continue) {
        process.exit(1)
      }
    })
    .then(getClient)
    .then(client => {
      return fetchAllDocuments(client)
        .then(documents =>
          documents.map(generatePatchesForDocument).filter(Boolean)
        )
        .then(confirm)
        .then(result => {
          if (result.noop) {
            return {success: true, noop: true}
          }
          if (result.continue) {
            return commit(result.patches, client).then(res => ({
              success: true,
              numDocs: res.length
            }))
          }
          return {success: false, cancelled: true}
        })
        .then(res => {
          if (res.noop) {
            console.log('\nNothing to do.\n')
          } else if (res.cancelled) {
            console.log('\nCancelled.\n')
          } else {
            console.log('\n✓  Migrated %d documents.\n', res.numDocs)
          }
        })
        .catch(error => {
          console.log(`\nData migration failed: ${error.message}\n`)
        })
    })
}

run()
