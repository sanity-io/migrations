#!/usr/bin/env node

/* eslint-disable no-console */
'use strict'

const fs = require('fs')
const path = require('path')
const createClient = require('@sanity/client')
const reduce = require('json-reduce').default
const inquirer = require('inquirer')
const ConfigStore = require('configstore')
const fetchAllDocuments = require('./fetchAllDocuments')

let sanityConfig
try {
  sanityConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'sanity.json')).toString())
} catch (error) {
  console.error(
    'Could not read sanity config from current working directory. Make sure you have a sanity.json.\nError was %s',
    error.message,
  )
  process.exit(1)
}
const datasetIndex = process.argv.indexOf('--dataset') + 1
const dataset = datasetIndex && process.argv[datasetIndex]
const targetDataset = dataset ? dataset : sanityConfig.api.dataset

function promptBackup() {
  return inquirer.prompt([
    {
      name: 'continue',
      type: 'confirm',
      default: false,
      message: `Fixing draft references.\n\nBefore doing this migration, make sure you have a backup handy.\n  "sanity dataset export <dataset> <somefile.ndjson>" is an easy way to do this.\n\nWould you like to perform the "fix draft references"-migration on dataset "${targetDataset}"?`,
    },
  ])
}

const DRAFTS_PREFIX = 'drafts.'

const _removeDraftPrefix = id => id.slice(DRAFTS_PREFIX.length)
const _addDraftPrefix = id => `${DRAFTS_PREFIX}${id}`
const getDraftId = id => (isDraftId(id) ? id : _addDraftPrefix(id))
const getPublishedId = id => (isDraftId(id) ? _removeDraftPrefix(id) : id)
const isDraftId = id => id.startsWith(DRAFTS_PREFIX)

function getBadRefsForDocument(document) {
  const badRefs = reduce(
    document,
    (acc, value, keyPath) => {
      if (!(typeof value === 'object')) {
        return acc
      }
      if (value._ref && !value._weak && isDraftId(value._ref)) {
        acc.push({
          path: serializePath(keyPath),
          fixed: { ...value, _ref: getPublishedId(value._ref) },
        })
      }
      return acc
    },
    [],
  )

  if (badRefs.length === 0) {
    return null
  }

  return badRefs.length === 0
    ? null
    : {
        document,
        badRefs,
      }
}

const keyBy = (items, accessor) =>
  items.reduce((acc, item) => Object.assign(acc, { [accessor(item)]: item }), {})

const flatten = array => array.reduce((flat, item) => flat.concat(item), [])
const uniqBy = (items, accessor) => {
  const keyed = keyBy(items, accessor)
  return Object.keys(keyed).map(key => keyed[key])
}

const getDocsWithPublishFlag = (allDocs, docsWithBadRefs) => {
  const allDocsById = keyBy(allDocs, doc => doc._id)
  return uniqBy(
    flatten(
      docsWithBadRefs.map(docWithBadRefs =>
        docWithBadRefs.badRefs.map(badRef => {
          const referencedDocId = badRef.fixed._ref
          const published = allDocsById[getPublishedId(referencedDocId)]
          const draft = allDocsById[getDraftId(referencedDocId)]

          return published
            ? null
            : {
                ...draft,
                _id: getPublishedId(badRef.fixed._ref),
              }
        }),
      ),
    ).filter(Boolean),
    placeholder => placeholder._id,
  )
}
const getSetPatches = docsWithBadRefs => {
  return docsWithBadRefs.map(docWithBadRefs => {
    return {
      document: docWithBadRefs.document,
      set: docWithBadRefs.badRefs.reduce(
        (set, badRef) =>
          Object.assign(set, {
            [badRef.path]: badRef.fixed,
          }),
        {},
      ),
    }
  })
}

function serializePath(path) {
  return path.reduce((target, part, i) => {
    const isIndex = typeof part === 'number'
    const seperator = i === 0 ? '' : '.'
    const add = isIndex ? `[${part}]` : `${seperator}${part}`
    return `${target}${add}`
  }, '')
}

function commit(needsPublish, setPatches, client) {
  let tx = client.transaction()
  tx = needsPublish.reduce((tx, doc) => tx.createIfNotExists(doc), tx)
  tx = setPatches.reduce(
    (tx, setPatch) => tx.patch(setPatch.document._id, { set: setPatch.set }),
    tx,
  )
  return tx.commit()
}

function createSummary(needsPublish, setPatches) {
  const publishSummary =
    needsPublish.length > 0
      ? `WARNING: Looks like there are several documents that references drafts which are not yet published. These drafts will need to be published in order to be able to create references to them.

  *** IF YOU CONTINUE, ${needsPublish.length} DOCUMENTS WILL BE PUBLISHED! ***\n`
      : ''

  const setPatchesSummary = setPatches
    .reduce((acc, patch) => {
      return acc
        .concat(`️📃  On document: ${patch.document._id}`)
        .concat(
          Object.keys(patch.set).map(
            keyPath => `    ✏  SET ${keyPath}:\n    ☞  ${JSON.stringify(patch.set[keyPath])}\n`,
          ),
        )
        .concat(' ')
    }, [])
    .join('\n')

  return [setPatchesSummary, publishSummary].filter(Boolean).join('\n')
}

function showSummaryAndConfirm(summary) {
  if (summary == null) {
    return { noop: true }
  }
  return inquirer.prompt([
    {
      name: 'continue',
      type: 'confirm',
      default: false,
      message: `The following operations will be performed:\n \n${summary}\n\nWould you like to continue?`,
    },
  ])
}

function getToken() {
  const authToken = new ConfigStore('sanity', {}, { globalConfigPath: true }).get('authToken')

  if (authToken) {
    return Promise.resolve(authToken)
  }

  return inquirer
    .prompt([
      {
        name: 'token',
        type: 'password',
        message: `Please enter a token with write access on project ${sanityConfig.api.projectId}`,
      },
    ])
    .then(result => result.token)
}

function getClient() {
  return getToken().then(token =>
    createClient({
      projectId: sanityConfig.api.projectId,
      dataset: targetDataset,
      useCdn: false,
      token,
    }),
  )
}

function run() {
  getClient().then(client => {
    return fetchAllDocuments(client)
      .then(allDocuments => {
        const docsWithBadRefs = allDocuments.map(getBadRefsForDocument).filter(Boolean)
        const placeholders = getDocsWithPublishFlag(allDocuments, docsWithBadRefs)
        const setPatches = getSetPatches(docsWithBadRefs)

        if (setPatches.length === 0) {
          return { success: true, noop: true }
        }

        const summary = createSummary(placeholders, setPatches)
        return showSummaryAndConfirm(summary).then(result => {
          if (result.noop) {
            return { success: true, noop: true }
          }
          if (!result.continue) {
            return { success: false, cancelled: true }
          }
          return commit(placeholders, setPatches, client).then(res => {
            return {
              success: true,
              transactionId: res.transactionId,
              documentIds: res.documentIds,
            }
          })
        })
      })
      .then(res => {
        if (res.noop) {
          console.log('\nNothing to do.\n')
        } else if (res.cancelled) {
          console.log('\nCancelled.\n')
        } else {
          console.log(
            '\n✅  Migrated %d documents in transaction %s.\n',
            res.documentIds.length,
            res.transactionId,
          )
        }
      })
      .catch(error => {
        console.log(`\nData migration failed: ${error.message}\n`)
      })
  })
}

promptBackup().then(run)
