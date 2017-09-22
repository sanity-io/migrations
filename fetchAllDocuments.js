async function fetchAllDocuments(client) {
  const limit = 250
  let docs = []
  let batch
  let offset = 0
  do {
    batch = await client.fetch(`* | order(_id) [${offset}...${offset + limit}]`)
    docs = docs.concat(batch)
    offset += limit
  } while (batch.length)

  return docs
}

module.exports = fetchAllDocuments
