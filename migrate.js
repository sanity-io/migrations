const client = require('part:@sanity/base/client').default
const reduce = require('json-reduce').default

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

function commit(patches) {
  return patches.reduce(
    (tx, patch) => tx.patch(patch.document._id, {set: patch.set}),
    client.transaction()
  )
    .commit()
}

fetchAllDocuments()
  .then(documents => documents.map(generatePatchesForDocument).filter(Boolean))
  .then(commit)
  .then(res => {
    console.log('✅ Migrated %d documents in transaction %s', res.documentIds.length, res.transactionId)
  })
