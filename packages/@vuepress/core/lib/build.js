'use strict'

module.exports = async function build (sourceDir, cliOptions = {}) {
  process.env.NODE_ENV = 'production'

  const { path } = require('@vuepress/shared-utils')
  const webpack = require('webpack')
  const readline = require('readline')
  const escape = require('escape-html')

  const { chalk, fs, logger, env } = require('@vuepress/shared-utils')
  const prepare = require('./prepare/index')
  const createClientConfig = require('./webpack/createClientConfig')
  const createServerConfig = require('./webpack/createServerConfig')
  const { createBundleRenderer } = require('vue-server-renderer')
  const { normalizeHeadTag, applyUserWebpackConfig } = require('./util/index')

  logger.wait('Extracting site metadata...')
  const ctx = await prepare(sourceDir, cliOptions, true /* isProd */)

  const { outDir, cwd } = ctx
  if (cwd === outDir) {
    return console.error(logger.error(chalk.red('Unexpected option: outDir cannot be set to the current working directory.\n'), false))
  }

  await fs.emptyDir(outDir)
  logger.debug('Dist directory: ' + chalk.gray(outDir))

  let clientConfig = createClientConfig(ctx, cliOptions).toConfig()
  let serverConfig = createServerConfig(ctx, cliOptions).toConfig()

  // apply user config...
  const userConfig = ctx.siteConfig.configureWebpack
  if (userConfig) {
    clientConfig = applyUserWebpackConfig(userConfig, clientConfig, false)
    serverConfig = applyUserWebpackConfig(userConfig, serverConfig, true)
  }

  // compile!
  const stats = await compile([clientConfig, serverConfig])

  const serverBundle = require(path.resolve(outDir, 'manifest/server.json'))
  const clientManifest = require(path.resolve(outDir, 'manifest/client.json'))

  // remove manifests after loading them.
  await fs.remove(path.resolve(outDir, 'manifest'))

  // find and remove empty style chunk caused by
  // https://github.com/webpack-contrib/mini-css-extract-plugin/issues/85
  // TODO remove when it's fixed
  await workaroundEmptyStyleChunk()

  // create server renderer using built manifests
  const renderer = createBundleRenderer(serverBundle, {
    clientManifest,
    runInNewContext: false,
    inject: false,
    shouldPrefetch: ctx.siteConfig.shouldPrefetch || (() => true),
    template: await fs.readFile(ctx.ssrTemplate, 'utf-8')
  })

  // pre-render head tags from user config
  const userHeadTags = (ctx.siteConfig.head || [])
    .map(renderHeadTag)
    .join('\n  ')

  // render pages
  logger.wait('Rendering static HTML...')
  for (const page of ctx.pages) {
    await renderPage(page)
  }

  // if the user does not have a custom 404.md, generate the theme's default
  if (!ctx.pages.some(p => p.path === '/404.html')) {
    await renderPage({ path: '/404.html' })
  }

  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)

  await ctx.pluginAPI.options.generated.apply()

  // DONE.
  const relativeDir = path.relative(cwd, outDir)
  logger.success(`${chalk.green('Success!')} Generated static files in ${chalk.cyan(relativeDir)}.\n`)

  // --- helpers ---

  function compile (config) {
    return new Promise((resolve, reject) => {
      webpack(config, (err, stats) => {
        if (err) {
          return reject(err)
        }
        if (stats.hasErrors()) {
          stats.toJson().errors.forEach(err => {
            console.error(err)
          })
          reject(new Error(`Failed to compile with errors.`))
          return
        }
        if (env.isDebug && stats.hasWarnings()) {
          stats.toJson().warnings.forEach(warning => {
            console.warn(warning)
          })
        }
        resolve(stats.toJson({ modules: false }))
      })
    })
  }

  function renderHeadTag (tag) {
    const { tagName, attributes, innerHTML, closeTag } = normalizeHeadTag(tag)
    return `<${tagName}${renderAttrs(attributes)}>${innerHTML}${closeTag ? `</${tagName}>` : ``}`
  }

  function renderAttrs (attrs = {}) {
    const keys = Object.keys(attrs)
    if (keys.length) {
      return ' ' + keys.map(name => `${name}="${escape(attrs[name])}"`).join(' ')
    } else {
      return ''
    }
  }

  async function renderPage (page) {
    const pagePath = page.path
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    process.stdout.write(`Rendering page: ${pagePath}`)

    // #565 Avoid duplicate description meta at SSR.
    const meta = (page.frontmatter && page.frontmatter.meta || []).filter(item => item.name !== 'description')
    const pageMeta = renderPageMeta(meta)

    const context = {
      url: pagePath,
      userHeadTags,
      pageMeta,
      title: 'VuePress',
      lang: 'en',
      description: ''
    }

    let html
    try {
      html = await renderer.renderToString(context)
    } catch (e) {
      console.error(logger.error(chalk.red(`Error rendering ${pagePath}:`), false))
      throw e
    }
    const filename = decodeURIComponent(pagePath.replace(/\/$/, '/index.html').replace(/^\//, ''))
    const filePath = path.resolve(outDir, filename)
    await fs.ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, html)
  }

  function renderPageMeta (meta) {
    if (!meta) return ''
    return meta.map(m => {
      let res = `<meta`
      Object.keys(m).forEach(key => {
        res += ` ${key}="${escape(m[key])}"`
      })
      return res + `>`
    }).join('')
  }

  async function workaroundEmptyStyleChunk () {
    const styleChunk = stats.children[0].assets.find(a => {
      return /styles\.\w{8}\.js$/.test(a.name)
    })
    if (!styleChunk) return
    const styleChunkPath = path.resolve(outDir, styleChunk.name)
    const styleChunkContent = await fs.readFile(styleChunkPath, 'utf-8')
    await fs.remove(styleChunkPath)
    // prepend it to app.js.
    // this is necessary for the webpack runtime to work properly.
    const appChunk = stats.children[0].assets.find(a => {
      return /app\.\w{8}\.js$/.test(a.name)
    })
    const appChunkPath = path.resolve(outDir, appChunk.name)
    const appChunkContent = await fs.readFile(appChunkPath, 'utf-8')
    await fs.writeFile(appChunkPath, styleChunkContent + appChunkContent)
  }
}
