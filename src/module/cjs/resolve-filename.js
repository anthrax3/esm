// Based on Node's `Module._resolveFilename`.
// Copyright Node.js contributors. Released under MIT license:
// https://github.com/nodejs/node/blob/master/lib/internal/modules/cjs/loader.js

import ENV from "../../constant/env.js"

import Module from "../../module.js"
import SafeModule from "../../safe/module.js"

import builtinEntries from "../../builtin-entries.js"
import errors from "../../errors.js"
import getModuleName from "../../util/get-module-name.js"
import isObject from "../../util/is-object.js"
import shared from "../../shared.js"

const {
  ELECTRON
} = ENV

const {
  ERR_INVALID_ARG_TYPE,
  MODULE_NOT_FOUND
} = errors

function resolveFilename(request, parent, isMain, options) {
  if (typeof request !== "string") {
    throw new ERR_INVALID_ARG_TYPE("request", "string")
  }

  if (Reflect.has(builtinEntries, request)) {
    return request
  }

  // Electron patches `Module._resolveFilename` to return its path.
  // https://github.com/electron/electron/blob/master/lib/common/reset-search-paths.js
  if (ELECTRON &&
      request === "electron") {
    return SafeModule._resolveFilename(request)
  }

  const cache = shared.memoize.moduleCJSResolveFilename
  const cacheKey = isObject(options)
    ? null
    : request + "\0" + getModuleName(parent) + "\0" + isMain

  if (cacheKey &&
      Reflect.has(cache, cacheKey)) {
    return cache[cacheKey]
  }

  let paths

  if (! cacheKey &&
      Array.isArray(options.paths)) {
    const fakeParent = new Module("", null)
    const fromPaths = options.paths

    paths = []

    for (const fromPath of fromPaths) {
      fakeParent.paths = Module._nodeModulePaths(fromPath)

      const lookupPaths = Module._resolveLookupPaths(request, fakeParent, true)

      if (paths.indexOf(fromPath) === -1) {
        paths.push(fromPath)
      }

      for (const lookupPath of lookupPaths) {
        if (paths.indexOf(lookupPath) === -1) {
          paths.push(lookupPath)
        }
      }
    }
  } else {
    paths = Module._resolveLookupPaths(request, parent, true)
  }

  const foundPath = Module._findPath(request, paths, isMain)

  if (foundPath) {
    return cacheKey
      ? cache[cacheKey] = foundPath
      : foundPath
  }

  throw new MODULE_NOT_FOUND(request)
}

export default resolveFilename
