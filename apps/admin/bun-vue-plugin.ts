// Registers .vue SFC support for bun test (bun has no built-in SFC loader).
import { parse, compileScript } from '@vue/compiler-sfc'

Bun.plugin({
  name: 'vue-sfc',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor, filename } = parse(source, { filename: args.path })
      const id = Math.random().toString(36).slice(2)

      if (descriptor.script || descriptor.scriptSetup) {
        const result = compileScript(descriptor, { id, inlineTemplate: true })
        return { contents: result.content, loader: 'ts' }
      }

      // Template-only SFC: build a minimal component from the template.
      const { compileTemplate } = await import('@vue/compiler-sfc')
      const template = compileTemplate({ source: descriptor.template?.content ?? '', filename, id })
      const code = [
        'const _sfc_component = { name: "anonymous" }',
        template.code,
        '_sfc_component.render = render',
        `export default _sfc_component`,
      ].join('\n')
      return { contents: code, loader: 'js' }
    })
  },
})
