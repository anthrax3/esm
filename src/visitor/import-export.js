import SOURCE_TYPE from "../constant/source-type.js"

import Visitor from "../visitor.js"

import encodeId from "../util/encode-id.js"
import errors from "../parse/errors.js"
import getNamesFromPattern from "../parse/get-names-from-pattern.js"
import keys from "../util/keys.js"
import shared from "../shared.js"

function init() {
  const {
    MODULE
  } = SOURCE_TYPE

  const ANON_NAME = encodeId("default")

  class ImportExportVisitor extends Visitor {
    finalizeHoisting() {
      const { top } = this
      const code =
        top.hoistedPrefixString +
        toModuleExport(this, top.hoistedExports) +
        top.hoistedExportsString +
        top.hoistedImportsString

      this.magicString.prependRight(top.insertCharIndex, code)
    }

    reset(rootPath, code, options) {
      this.addedDirectEval = false
      this.addedDynamicImport = false
      this.addedImportExport = false
      this.addedImportMeta = false
      this.addedIndirectEval = false
      this.assignableExports = { __proto__: null }
      this.changed = false
      this.code = code
      this.dependencySpecifiers = { __proto__: null }
      this.exportNames = []
      this.exportStars = []
      this.generateVarDeclarations = options.generateVarDeclarations
      this.importLocals = { __proto__: null }
      this.magicString = options.magicString
      this.possibleIndexes = options.possibleIndexes
      this.runtimeName = options.runtimeName
      this.sourceType = options.sourceType
      this.strict = options.strict
      this.top = options.top
    }

    visitCallExpression(path) {
      const node = path.getValue()

      if (! node.arguments.length) {
        this.visitChildren(path)
        return
      }

      const { callee } = node

      if (callee.name === "eval") {
        // Support direct eval:
        // eval(code)
        this.changed =
        this.addedDirectEval = true

        const { runtimeName } = this

        let code = runtimeName + ".c"

        if (! this.strict) {
          code = "(eval===" + runtimeName + ".v?" + code + ":" + runtimeName + ".k)"
        }

        this.magicString
          .prependRight(callee.end, "(" + code)
          .prependRight(node.end, ")")
      } else if (callee.type === "Import") {
        // Support dynamic import:
        // import("mod")
        this.changed =
        this.addedDynamicImport = true

        overwrite(this, callee.start, callee.end, this.runtimeName + ".i")
      }

      this.visitChildren(path)
    }

    visitIdentifier(path) {
      const node = path.getValue()

      if (node.name !== "eval") {
        return
      }

      const parent = path.getParentNode()
      const { type } = parent

      if (type === "CallExpression" ||
          (type === "AssignmentExpression" &&
          parent.left.name === "eval")) {
        return
      }

      // Support indirect eval:
      // o = { eval }
      // o.e = eval
      // (0, eval)(code)
      this.changed =
      this.addedIndirectEval = true

      const { runtimeName } = this

      let code = runtimeName + ".g"

      if (! this.strict) {
        code = "(eval===" + runtimeName + ".v?" + code + ":eval)"
      }

      if (type === "Property" &&
          parent.shorthand) {
        this.magicString.prependRight(node.end, ":" + code)
      } else {
        overwrite(this, node.start, node.end, code)
      }
    }

    visitImportDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      // Suport import statements:
      // import defaultName from "mod"
      // import * as name from "mod"
      // import { export as alias } from "mod"
      // import { export1 , export2, ...exportN } from "mod"
      // import { export1 , export2 as alias2, [...] } from "mod"
      // import defaultName, { export1, [ , [...] ] } from "mod"
      // import defaultName, * as name from "mod"
      // import "mod"
      this.changed =
      this.addedImportExport = true

      let i = -1
      const node = path.getValue()
      const { specifiers } = node
      const specifierMap = createSpecifierMap(this, node)
      const specifierString = getSourceString(this, node)

      let hoistedCode = specifiers.length
        ? (this.generateVarDeclarations ? "var " : "let ")
        : ""

      const lastIndex = specifiers.length - 1

      for (const specifier of specifiers) {
        hoistedCode +=
          specifier.local.name +
          (++i === lastIndex ? ";" : ",")
      }

      hoistedCode += toModuleImport(
        this,
        specifierString,
        specifierMap
      )

      hoistImports(this, node, hoistedCode)
      addImportLocals(this, specifierMap)
    }

    visitExportAllDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      // Support re-exporting an imported module:
      // export * from "mod"
      this.changed =
      this.addedImportExport = true

      const node = path.getValue()
      const { runtimeName } = this
      const { source } = node
      const specifierString = getSourceString(this, node)
      const specifierName = specifierString.slice(1, -1)

      const hoistedCode = pad(
        this,
        runtimeName + ".w(" + specifierString,
        node.start,
        source.start
      ) + pad(
        this,
        ',[["*",null,' + runtimeName + ".n()]]);",
        source.end,
        node.end
      )

      this.exportStars.push(specifierName)

      addToDependencySpecifiers(this, specifierName)
      hoistImports(this, node, hoistedCode)
    }

    visitExportDefaultDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      this.changed =
      this.addedImportExport = true

      // Export specifier states:
      //   1 - Own
      //   2 - Imported
      //   3 - Conflicted
      this.exportNames.push("default")

      const node = path.getValue()
      const { declaration } = node
      const { id, type } = declaration

      if (type === "FunctionDeclaration" ||
          (id && type === "ClassDeclaration")) {
        // Support exporting default class and function declarations:
        // export default function named() {}
        const name = id
          ? id.name
          : safeName(ANON_NAME, this.top.identifiers)

        if (! id) {
          // Convert anonymous functions to named functions so they are hoisted.
          this.magicString.prependRight(declaration.functionParamsStart, " " + name)
        }

        // If the exported default value is a function or class declaration,
        // it's important that the declaration be visible to the rest of the
        // code in the exporting module, so we must avoid compiling it to a
        // named function or class expression.
        hoistExports(this, node, [["default", name]])
      } else {
        // Otherwise, since the exported value is an expression, we use the
        // special `runtime.default(value)` form.
        let prefix = this.runtimeName + ".d("
        let suffix = ");"

        if (type === "SequenceExpression") {
          // If the exported expression is a comma-separated sequence expression,
          // `this.code.slice(declaration.start, declaration.end)` may not include
          // the vital parentheses, so we should wrap the expression with parentheses
          // to make absolutely sure it is treated as a single argument to
          // `runtime.default()`, rather than as multiple arguments.
          prefix += "("
          suffix = ")" + suffix
        }

        overwrite(this, node.start, declaration.start, prefix)
        overwrite(this, declaration.end, node.end, suffix)
      }

      path.call(this, "visitWithoutReset", "declaration")
    }

    visitExportNamedDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      this.changed =
      this.addedImportExport = true

      const node = path.getValue()
      const { declaration } = node

      if (declaration) {
        const pairs = []
        const { id, type } = declaration

        if (id &&
            (type === "ClassDeclaration" ||
            type === "FunctionDeclaration")) {
          // Support exporting named class and function declarations:
          // export function named() {}
          const { name } = id
          pairs.push([name, name])
        } else if (type === "VariableDeclaration") {
          // Support exporting variable lists:
          // export let name1, name2, ..., nameN
          for (const decl of declaration.declarations) {
            const names = getNamesFromPattern(decl.id)

            for (const name of names) {
              pairs.push([name, name])
            }
          }
        }

        hoistExports(this, node, pairs)

        // Skip adding declared names to `this.assignableExports` if the
        // declaration is a const-kinded VariableDeclaration, because the
        // assignmentVisitor doesn't need to worry about changes to these
        // variables.
        if (canExportedValuesChange(node)) {
          addAssignableExports(this, pairs)
        }

        path.call(this, "visitWithoutReset", "declaration")
        return
      }

      const { specifiers } = node

      if (! specifiers) {
        return
      }

      // Support exporting specifiers:
      // export { name1, name2, ..., nameN }
      if (node.source === null) {
        const { identifiers } = this.top
        const pairs = []

        for (const specifier of specifiers) {
          const localName = specifier.local.name

          if (identifiers.indexOf(localName) === -1) {
            throw new errors.SyntaxError(
              this.magicString.original,
              specifier.start,
              "Export '" + localName + "' is not defined in module"
            )
          }

          pairs.push([specifier.exported.name, localName])
        }

        hoistExports(this, node, pairs)
        addAssignableExports(this, pairs)
        return
      }

      // Support re-exporting specifiers of an imported module:
      // export { name1, name2, ..., nameN } from "mod"
      const { exportNames } = this
      const specifierMap = { __proto__: null }

      const specifierString = getSourceString(this, node)
      const specifierName = specifierString.slice(1, -1)

      addToDependencySpecifiers(this, specifierName)

      for (const specifier of specifiers) {
        const exportName = specifier.exported.name
        const localName = specifier.local.name

        exportNames.push(exportName)
        addToDependencySpecifiers(this, specifierName, localName)

        addToSpecifierMap(
          this,
          specifierMap,
          localName,
          this.runtimeName + ".entry.namespace." + exportName
        )
      }

      hoistImports(this, node, toModuleImport(
        this,
        specifierString,
        specifierMap
      ))
    }

    visitMetaProperty(path) {
      const { meta } = path.getValue()

      if (meta.name === "import") {
        // Support import.meta.
        this.changed =
        this.addedImportMeta = true

        overwrite(this, meta.start, meta.end, this.runtimeName + "._")
      }
    }
  }

  function addAssignableExports(visitor, pairs) {
    const { assignableExports } = visitor

    for (const [, localName] of pairs) {
      assignableExports[localName] = true
    }
  }

  function addImportLocals(visitor, specifierMap) {
    const { importLocals } = visitor

    for (const importName in specifierMap) {
      for (const localName of specifierMap[importName]) {
        importLocals[localName] = true
      }
    }
  }

  function addToDependencySpecifiers(visitor, specifierName, exportName) {
    const { dependencySpecifiers } = visitor

    const exportNames =
      dependencySpecifiers[specifierName] ||
      (dependencySpecifiers[specifierName] = [])

    if (exportName &&
        exportName !== "*" &&
        exportNames.indexOf(exportName) === -1) {
      exportNames.push(exportName)
    }
  }

  function addToSpecifierMap(visitor, specifierMap, importName, localName) {
    const localNames =
      specifierMap[importName] ||
      (specifierMap[importName] = [])

    localNames.push(localName)
  }

  function canExportedValuesChange({ declaration, type }) {
    if (type === "ExportDefaultDeclaration") {
      return declaration.type === "FunctionDeclaration" ||
            declaration.type === "ClassDeclaration"
    }

    if (type === "ExportNamedDeclaration" &&
        declaration &&
        declaration.type === "VariableDeclaration" &&
        declaration.kind === "const") {
      return false
    }

    return true
  }

  function createSpecifierMap(visitor, node) {
    const { specifiers } = node
    const specifierMap = { __proto__: null }

    for (const specifier of specifiers) {
      let importName = "*"
      const { type } = specifier

      if (type === "ImportSpecifier") {
        importName = specifier.imported.name
      } else if (type === "ImportDefaultSpecifier") {
        importName = "default"
      }

      addToSpecifierMap(visitor, specifierMap, importName, specifier.local.name)
    }

    return specifierMap
  }

  // Gets a string representation (including quotes) from an import or
  // export declaration node.
  function getSourceString(visitor, { source }) {
    return visitor.code.slice(source.start, source.end)
  }

  function hoistExports(visitor, node, pairs) {
    visitor.top.hoistedExports.push(...pairs)

    if (node.declaration) {
      preserveChild(visitor, node, "declaration")
    } else {
      preserveLine(visitor, node)
    }
  }

  function hoistImports(visitor, node, hoistedCode) {
    preserveLine(visitor, node)
    visitor.top.hoistedImportsString += hoistedCode
  }

  function overwrite(visitor, oldStart, oldEnd, newCode) {
    const padded = pad(visitor, newCode, oldStart, oldEnd)

    if (oldStart !== oldEnd) {
      visitor.magicString.overwrite(oldStart, oldEnd, padded)
    } else if (padded !== "") {
      visitor.magicString.prependRight(oldStart, padded)
    }
  }

  function pad(visitor, newCode, oldStart, oldEnd) {
    const oldCode = visitor.code.slice(oldStart, oldEnd)
    const oldLines = oldCode.split("\n")
    const oldLineCount = oldLines.length
    const newLines = newCode.split("\n")
    const lastIndex = newLines.length - 1

    let i = lastIndex - 1

    while (++i < oldLineCount) {
      const oldLine = oldLines[i]
      const lastCharCode = oldLine.charCodeAt(oldLine.length - 1)

      if (i > lastIndex) {
        newLines[i] = ""
      }

      if (lastCharCode === 13 /* \r */) {
        newLines[i] += "\r"
      }
    }

    return newLines.join("\n")
  }

  function preserveChild(visitor, node, childName) {
    const child = node[childName]
    overwrite(visitor, node.start, child.start, "")
  }

  function preserveLine(visitor, { end, start }) {
    overwrite(visitor, start, end, "")
  }

  function safeName(name, localNames) {
    return localNames.indexOf(name) === -1
      ? name
      : safeName(encodeId(name), localNames)
  }

  function toModuleExport(visitor, pairs) {
    let code = ""

    if (! pairs.length) {
      return code
    }

    let i = -1
    const lastIndex = pairs.length - 1
    const { exportNames } = visitor

    code += visitor.runtimeName + ".e(["

    for (const [exportName, localName] of pairs) {
      exportNames.push(exportName)

      code +=
        '["' + exportName + '",()=>' +
        localName +
        "]"

      if (++i !== lastIndex) {
        code += ","
      }
    }

    code += "]);"

    return code
  }

  function toModuleImport(visitor, specifierString, specifierMap) {
    const importNames = keys(specifierMap)
    const specifierName = specifierString.slice(1, -1)

    let code = visitor.runtimeName + ".w(" + specifierString

    addToDependencySpecifiers(visitor, specifierName)

    if (! importNames.length) {
      return code + ");"
    }

    let i = -1
    const lastIndex = importNames.length - 1

    code += ",["

    for (const importName of importNames) {
      const localNames = specifierMap[importName]
      const valueParam = safeName("v", localNames)

      addToDependencySpecifiers(visitor, specifierName, importName)

      code +=
        // Generate plain functions, instead of arrow functions,
        // to avoid a perf hit in Node 4.
        '["' +
        importName + '",["' +
        localNames.join('","') +
        '"],function(' + valueParam + "){" +
        // Multiple local variables become a compound assignment.
        localNames.join("=") + "=" + valueParam +
        "}]"

      if (++i !== lastIndex) {
        code += ","
      }
    }

    code += "]);"

    return code
  }

  return new ImportExportVisitor
}

export default shared.inited
  ? shared.module.visitorImportExport
  : shared.module.visitorImportExport = init()
