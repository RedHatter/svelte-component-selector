import { parse, walk } from 'svelte/compiler'
import MagicString from 'magic-string'

function isUpperCase(char) {
  return char >= 65 && char <= 90
}

// https://github.com/sveltejs/svelte/blob/master/src/compiler/compile/utils/hash.ts
// https://github.com/darkskyapp/string-hash/blob/master/index.js
function hash(str) {
  str = str.replace(/\r/g, '')
  let hash = 5381
  let i = str.length
  while (i--) hash = ((hash << 5) - hash) ^ str.charCodeAt(i)
  return (hash >>> 0).toString(36)
}

// https://github.com/sveltejs/svelte/src/compiler/compile/utils/get_name_from_filename.ts#L1
function get_name_from_filename(filename) {
  if (!filename) return null

  const parts = filename.split(/[/\\]/).map(encodeURI)

  if (parts.length > 1) {
    const index_match = parts[parts.length - 1].match(/^index(\.\w+)/)
    if (index_match) {
      parts.pop()
      parts[parts.length - 1] += index_match[1]
    }
  }

  const base = parts
    .pop()
    .replace(/%/g, 'u')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z_$0-9]+/g, '_')
    .replace(/^_/, '')
    .replace(/_$/, '')
    .replace(/^(\d)/, '_$1')

  if (!base) {
    throw new Error(`Could not derive component name from file ${filename}`)
  }

  return base[0].toUpperCase() + base.slice(1)
}

function defaultCssHash({ hash, css, parent, child, filename }) {
  return `svelte-${hash(css)}-${child.toLowerCase()}`
}

export default function (cssHash = defaultCssHash, propName = '_$$class') {
  return {
    markup: async ({ content, filename }) => {
      let css = undefined
      let script = undefined
      content = await svelte.preprocess(content, {
        script: ({ content }) => {
          script = content
          return { code: '/* script-marker */' }
        },
        style: ({ content }) => {
          css = content
          return { code: '/* css-marker */' }
        },
      })

      const ast = parse(content, { filename })
      const magicContent = new MagicString(content)

      walk(ast.html, {
        enter(node) {
          switch (node.type) {
            case 'InlineComponent':
              if (css === undefined || !css.includes(node.name)) return

              const className = cssHash({
                hash,
                css: css,
                parent: get_name_from_filename(filename) || 'Component',
                child: node.name,
                filename,
              })
              // <Component _$$class='className' />
              magicContent.appendLeft(
                node.start + node.name.length + 1,
                ` _$$class='${className}'`,
              )
              break
            case 'Element':
              const attr = node.attributes.find(
                (n) => n.type === 'Attribute' && n.name === 'class',
              )
              // <element class={_$$class}></element>
              if (attr === undefined) {
                magicContent.appendLeft(
                  node.start + node.name.length + 1,
                  ` class={${propName}}`,
                )
                break
              }

              const value = attr.value[0]
              // <element class={'value ' + _$$class}></element>
              if (value.type === 'Text')
                magicContent.overwrite(
                  value.start - 1,
                  value.end + 1,
                  `{'${value.raw} ' + ${propName}}`,
                )
              // <element class={value + " " + _$$class}></element>
              else if (value.type === 'MustacheTag')
                magicContent.appendLeft(value.end - 1, ' + " " + ' + propName)
              break
          }
        },
      })

      return {
        code: magicContent
          .toString()
          .replace('/* css-marker */', css)
          .replace('/* script-marker */', script),
        map: magicContent.generateMap({ source: filename }).toString(),
      }
    },
    script: ({ content }) => ({
      code: content + '\nexport let _$$class = ""\n',
    }),
    style: ({ content, filename }) => {
      const ast = parse(`<style>${content}</style>`, { filename })
      const offset = '<style>'.length
      const magicContent = new MagicString(content)

      walk(ast, {
        enter(node) {
          if (node.type !== 'Selector') return
          this.skip()

          const index = node.children.findIndex(
            (node) =>
              node.type === 'TypeSelector' &&
              isUpperCase(node.name.codePointAt(0)),
          )
          if (index === -1) return

          const component = node.children[index]
          const siblings = node.children.slice(index + 1)
          const className =
            '.' +
            cssHash({
              hash,
              css: content,
              parent: get_name_from_filename(filename) || 'Component',
              child: component.name,
              filename,
            })

          magicContent.overwrite(
            component.start - offset,
            component.end - offset,
            siblings.length === 0 ? ':global(' + className : ':global(',
          )
          magicContent.appendRight(
            siblings[siblings.length - 1].end - offset,
            ')',
          )

          let group = []
          const groups = [group]
          for (const selector of siblings) {
            if (
              selector.type === 'WhiteSpace' ||
              selector.type === 'Combinator'
            ) {
              group = [selector]
              groups.push(group)
            } else {
              group.push(selector)
            }
          }

          for (const group of groups) {
            let i = group.length

            while (i--) {
              const selector = group[i]
              if (
                selector.type === 'PseudoElementSelector' ||
                selector.type === 'PseudoClassSelector'
              ) {
                if (selector.name !== 'root' && selector.name !== 'host') {
                  if (i === 0)
                    magicContent.prependRight(
                      selector.start - offset,
                      className,
                    )
                }
                continue
              }

              if (selector.type === 'TypeSelector' && selector.name === '*') {
                magicContent.overwrite(
                  selector.start - offset,
                  selector.end,
                  className,
                )
              } else {
                magicContent.appendLeft(selector.end - offset, className)
              }

              break
            }
          }
        },
      })

      return {
        code: magicContent.toString(),
        map: magicContent.generateMap({ source: filename }).toString(),
      }
    },
  }
}
