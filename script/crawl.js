"use strict"

let request = require('request')
let parseXmlString = require('xml2js').parseString
let cheerio = require('cheerio')
let fs = require('fs')
let mkdirp = require('mkdirp')
let dirname = require('path').dirname
let indent = require('indent-string')

const INDEX_URL = 'https://openui5.hana.ondemand.com/docs/api/index.xml'
const DETAIL_URL_PREFIX = 'https://openui5.hana.ondemand.com/docs/api/'
const DOC_URL_PREFEX = 'https://openui5.hana.ondemand.com/#docs/api/'
const TREE_OUT = 'out/tree.json'
const OPENUI5_TEMPLATE = 'openui5-template.js'
const OPENUI5_OUT = '../openui5.js'

let tree = {
  "!name": "openui5"
}
let promisesDone = 0;
let lastShownPercentage = -1
let readDetailsQueue = []
let retryQueue = []

let mapTypeToTern = function(type) {
  let types = type.split('|')
  if(types.length === 0) return ''
  type = types[0]

  const ARRAY_PATTERN = [
    /(.*)\[\]/, // integer[]
    /array\((.*)\)/ // array(integer)
  ]
  let isArray = ARRAY_PATTERN.some(function(regex) {
    let matches = regex.exec(type)
    if(matches && matches[1]) {
      type = matches[1]
      return true
    }
  })

  if(type === 'int') type = 'number'
  if(type === 'boolean') type = 'bool'
  if(type === '*') type = '?'

  if (isArray) type = '[' + type + ']'

  return type
}

let buildTree = function(objects, currentRoot) {
  objects.forEach(function(object) {
    let branch = currentRoot[object.name[0]] = {}
    readDetailsQueue.push({ref: object.ref[0], branch: branch})
    if(!!object.children) buildTree(object.children[0].namespace, branch)
  })
}

let readAttributesForNode = function(ref, branch) {
  let detailUrl = DETAIL_URL_PREFIX + ref

  let promise = new Promise(function(resolve, reject){

    request(detailUrl, function (error, response, data) {
      if (!error && response.statusCode == 200) {
        let $ = cheerio.load(data)
        let doc = $('div.full-description > p:first-of-type').text().trim()
        let url = DOC_URL_PREFEX + ref
        let methods = []

        let methodsElement = $('div.sectionTitle:contains(" Method Detail ") + div.sectionItems')
        cheerio('div.sectionItem', methodsElement).each(function(i, method) {
          let methodName = cheerio('div.itemTitle', method).clone().children().remove().end().text().trim().split('.')
          methodName = methodName[methodName.length - 1]
          let methodReturns = cheerio('div.itemTitle > span.light', method).text().trim()
          methodReturns = methodReturns.substr(1, methodReturns.length - 1).trim()

          let methodArguments = []
          let argumentsElement = cheerio('div.heading:contains("Parameters:") + table.methodItem > tbody > tr', method)
          argumentsElement.each(function(i, argument) {
            let argumentName = cheerio('td.methodItemName > b', argument).text().trim()
            let argumentIsOptional = cheerio('td.methodItemName > i.help', argument).attr('title') === 'Optional parameter'
            let argumentType = cheerio('td.methodItemType', argument).text().trim()
            argumentType = argumentType.substring(1, argumentType.length - 1)
            methodArguments.push({
              name: argumentName,
              type: argumentType,
              isOptional: argumentIsOptional
            })
          })

          let methodDocElement = cheerio('div.full-description', method).clone()
          cheerio('p', methodDocElement).remove()
          let methodDoc = methodDocElement.text().trim()
          let methodUrl = url + '#' + methodName

          methods.push({
            name: methodName,
            returns: methodReturns,
            arguments: methodArguments,
            doc: methodDoc,
            url: methodUrl
          })
        })

        resolve({doc: doc, url: url, methods: methods})
      } else {
        reject({reason: error.code, ref: ref, branch: branch})
      }
    })
  }).then(function(data){
    branch['!doc'] = data.doc
    branch['!url'] = data.url
    addMethodsToBranch(data.methods, branch)
  }).catch(function(data){
    console.log('Warning: ' + data.reason + ' for ' + data.ref + ' -- will retry')
    retryQueue.push({ref: data.ref, branch: data.branch})
  })
  return promise
}

let addMethodsToBranch = function(methods, branch) {
  methods.forEach(function(method) {
    let type = 'fn('
    type += method.arguments.map(function(arg){
      if(arg.name.includes('.')) return null
      let argString = arg.name
      if (arg.isOptional) argString += '?'
      argString += ': ' + mapTypeToTern(arg.type)
      return argString
    }).join(', ')
    type += ')'
    if(!!method.returns) type += ' -> ' + mapTypeToTern(method.returns)

    branch[method.name] = {
      '!doc': method.doc,
      '!url': method.url,
      '!type': type
    }
  })
}

let readAttributes = function() {
  return new Promise(function(resolve, reject){
    console.log('Reading details of ' + readDetailsQueue.length + ' entries...')
    let promises = []
    readDetailsQueue.forEach(function(entry) {
      promises.push(readAttributesForNode(entry.ref, entry.branch))
    })
    Promise.all(promises).then(function() {
      readDetailsQueue = retryQueue
      retryQueue = []

      if(readDetailsQueue.length > 0) {
        readAttributes().then(resolve)
      } else {
        resolve()
      }
    })
  })
}

console.log('Loading index file at ' + INDEX_URL)

new Promise(function(resolve, reject) {
  request(INDEX_URL, function (error, response, data) {
    if (!error && response.statusCode == 200) {
      resolve(data)
    } else {
      reject('Error while loading index file: ' + error.code)
    }
  })
}).then(function(data) {
  return new Promise(function(resolve, reject) {
    parseXmlString(data, function(err, result) {
      resolve(result.index)
    })
  })
}).then(function(data) {
  console.log('Parsing index...')
  buildTree(data.namespace, tree)
}).then(function(){
  return readAttributes()
}).then(function () {
  console.log('Writing output...')

  fs.readFile(OPENUI5_TEMPLATE, 'utf8', function(err, data){
    if (err) console.log('Error while writing output: ' + err)
    else {
      let stringifiedTree = JSON.stringify(tree, null, 2)
      let openui5Content = data.replace('"{{defs}}"', indent(stringifiedTree, ' ', 2))

      mkdirp(dirname(OPENUI5_OUT), function (err) {
        if (err) console.log('Error while writing ' + OPENUI5_OUT + ': ' + err)
        else fs.writeFile(OPENUI5_OUT, openui5Content, function(err) {
          if (err) console.log('Error while writing ' + OPENUI5_OUT + ': ' + err)
          else console.log("Tern plugin written to " + OPENUI5_OUT)
        })
      })

      mkdirp(dirname(TREE_OUT), function (err) {
        if (err) console.log('Error while writing ' + TREE_OUT + ': ' + err)
        else fs.writeFile(TREE_OUT, stringifiedTree, function(err) {
          if (err) console.log('Error while writing ' + TREE_OUT + ': ' + err)
          else console.log("Tree written to " + TREE_OUT)
        })
      })
    }
  })
}).catch(function(reason) {
  console.log(reason)
})