#!/usr/bin/env node
require('@sanity/plugin-loader/register')
const fs = require('fs')
const path = require('path')
const client = require('part:@sanity/base/client')
const reduce = require('json-reduce').default
const inquirer = require('inquirer')

let sanityConfig
try {
  sanityConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'sanity.json')).toString())
} catch (error) {
  console.error('Could not read sanity config from current working directory. Make sure you have a sanity.json')
  console.error(error)
  process.exit(1)
}
function fetchAllDocuments() {
  return client.fetch('*[!(_id in path("_.**"))][0...10000] {...}')
}

function generatePatchesForDocument(document) {
  const patches = reduce(document, (acc, value, path) => {
    const key = path[path.length - 1]
    return (key === '_type' && value === 'date')
      ? Object.assign({}, acc, {[path.join('.')]: 'richDate'})
      : acc
  }, {})

  return (Object.keys(patches).length === 0) ? null : {
    document,
    set: patches
  }
}

function commit(patches, token) {
  return patches.reduce(
    (tx, patch) => tx.patch(patch.document._id, {set: patch.set}),
    client.config({token, useCdn: false})
      .transaction()
  )
    .commit()
}

function confirm(patches) {
  const summary = patches.reduce((summary, patch) => {
    return summary.concat(`️📃  On document: ${patch.document._id}`).concat(
      Object.keys(patch.set).map(path => `    ✏  SET ${path} = ${patch.set[path]}`)
    )
  }, [])

  if (summary.length === 0) {
    return {continue: false}
  }

  return inquirer.prompt([{
    name: 'continue',
    type: 'confirm',
    message: `The following operations will be performed:\n\n${summary.join('\n')}\n\nWould you like to continue?`
  }])
    .then(result => {
      return {
        ...result,
        patches
      }
    })
}

function getToken() {
  return inquirer.prompt([{
    name: 'token',
    type: 'password',
    message: `Please enter a token with write access on project ${sanityConfig.api.projectId}`
  }])
    .then(result => result.token)
}

function run() {
  return fetchAllDocuments()
    .then(documents => documents.map(generatePatchesForDocument).filter(Boolean))
    .then(confirm)
    .then(result => {
      if (result.continue) {
        return getToken().then(token => commit(result.patches, token).then(res => {
          return {success: true, transactionId: res.transactionId, documentIds: res.documentIds}
        }))
      }
      return {success: false, cancelled: true}
    })
    .then(res => {
      if (res.cancelled) {
        console.log('Cancelled.')
      }
      else {
        console.log('✅  Migrated %d documents in transaction %s', res.documentIds.length, res.transactionId)
      }
    })
    .catch(error => {
      console.log(`Data migration failed: ${error.message}`)
    })
}

run()