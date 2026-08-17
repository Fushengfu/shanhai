import { bootstrap } from './bootstrap'

async function main(): Promise<void> {
  const runtime = await bootstrap()
  const message = process.argv[2] ?? '你好'
  const result = await runtime.run(message)
  console.log(result)
  await runtime.kernel.dispose()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
