// Usage: node svg2png.js [--size=<width>[x<height>]] [--out=<dir>] [files...]

const fs = require('fs')
const path = require('path')
const child_process = require('child_process')
const CDP = require('chrome-remote-interface')
const ProgressBar = require('progress')

let outputDir = '.'
let size = [128, 128]

const urls = process.argv.slice(2).filter(arg => {
  if (arg.startsWith('--size=')) {
    const dimensions = arg.split('=')[1]
    const [width, height] = dimensions.split('x')
    size = [parseInt(width), height ? parseInt(height) : parseInt(width)]
  } else if (arg.startsWith('--out=')) {
    outputDir = arg.split('=')[1]
  } else {
    return true
  }
})

const connectionOptions = {
  port: 9090
}

function detectGoogleChrome() {
  if (process.env['GOOGLE_CHROME_BIN']) {
    return process.env['GOOGLE_CHROME_BIN']
  } else if (process.platform == 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  } else {
    return 'google-chrome'
  }
}

const browser = child_process.spawn(detectGoogleChrome(), [
  '--headless',
  '--disable-gpu',
  '--remote-debugging-address=0.0.0.0',
  `--remote-debugging-port=${connectionOptions.port}`
], { stdio: 'ignore' })

function svgToFullscreen() {
  const svg = document.documentElement
  if (svg.hasAttribute("width")) {
    if (!svg.hasAttribute("viewBox")) {
      svg.setAttribute("viewBox", `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`)
    }
    svg.removeAttribute("width")
    svg.removeAttribute("height")
  }
}

async function timeout(delay) {
  return new Promise(resolve => {
    setTimeout(() => { resolve() }, delay)
  })
}

async function connectWithRetries(retries, delay) {
  try {
    return await CDP(connectionOptions)
  } catch (err) {
    if ((err.errno === 'ECONNREFUSED' || err.message === 'No inspectable targets') && retries > 0) {
      await timeout(delay)
      return connectWithRetries(retries - 1, delay)
    }
    throw err
  }
}

async function processUrls(urls) {
  const client = await connectWithRetries(30, 100)
  const version = await CDP.Version(connectionOptions)
  console.log(version.Browser)
  const {Emulation, Page, Runtime} = client

  let exitStatus = 0
  try {
    await Emulation.setDeviceMetricsOverride({
      width: size[0],
      height: size[1],
      fitWindow: true,
      deviceScaleFactor: 1,
      mobile: false
    })
    await Emulation.setDefaultBackgroundColorOverride({color: { r:0, g:0, b:0, a:0 }})

    await Page.enable()
    await Runtime.enable()

    let progress
    if (urls.length > 1) {
      progress = new ProgressBar(':bar ETA :etas', {total: urls.length})
    }
    for (const arg of urls) {
      const url = /^https?:/.test(arg) ? arg : `file://${path.resolve(arg)}`
      const result = await Page.navigate({url})
      if (result.errorText) {
        console.error('%s: %s', arg, result.errorText)
        exitStatus = 1
      } else {
        await Page.domContentEventFired()
        await Runtime.evaluate({
          expression: `(${svgToFullscreen.toString()})()`
        })
        const outputFile = path.resolve(outputDir, `${path.basename(arg, '.svg')}.png`)
        const {data} = await Page.captureScreenshot()
        fs.writeFileSync(outputFile, Buffer.from(data, 'base64'))
      }
      if (progress) progress.tick()
    }
  } finally {
    client.close()
  }
  return exitStatus
}

processUrls(urls).then(null, err => {
  console.error(err)
  return 1
}).then(exitStatus => {
  browser.kill()
  if (exitStatus != 0) process.exit(exitStatus)
})
