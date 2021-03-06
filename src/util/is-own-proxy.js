import ESM from "../constant/esm.js"

import OwnProxy from "../own/proxy.js"

import { inspect } from "../safe/util.js"
import isObjectLike from "./is-object-like.js"
import shared from "../shared.js"

function init() {
  const {
    PKG_PREFIX
  } = ESM

  let inspectDepth = 0

  const endMarkerRegExp = new RegExp(
    "[\\[\"']" +
    PKG_PREFIX +
    ":proxy['\"\\]]\\s*:\\s*1\\s*\\}\\s*.?$"
  )

  const liteInspectOptions = {
    __proto__: null,
    breakLength: Infinity,
    colors: false,
    compact: true,
    customInspect: false,
    depth: 0,
    maxArrayLength: 0,
    showHidden: false,
    showProxy: true
  }

  const markerInspectOptions = {
    __proto__: null,
    breakLength: Infinity,
    colors: false,
    compact: true,
    customInspect: false,
    depth: 1,
    maxArrayLength: 0,
    showHidden: true,
    showProxy: true
  }

  function isOwnProxy(value) {
    return OwnProxy.instances.has(value) ||
      isOwnProxyFallback(value)
  }

  function isOwnProxyFallback(value) {
    if (! shared.support.inspectProxies ||
        ! isObjectLike(value) ||
        ++inspectDepth !== 1) {
      return false
    }

    let inspected

    try {
      inspected = inspect(value, liteInspectOptions)
    } finally {
      inspectDepth -= 1
    }

    if (! inspected.startsWith("Proxy")) {
      return false
    }

    inspectDepth += 1

    try {
      inspected = inspect(value, markerInspectOptions)
    } finally {
      inspectDepth -= 1
    }

    return endMarkerRegExp.test(inspected)
  }

  return isOwnProxy
}

export default shared.inited
  ? shared.module.utilIsOwnProxy
  : shared.module.utilIsOwnProxy = init()
