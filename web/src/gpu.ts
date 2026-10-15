// The part of WebGPU this file uses. The TypeScript libraries do not declare it.
type Gpu = { requestAdapter(): Promise<unknown> }

// Whether the browser gives a GPU adapter. Having `navigator.gpu` is not
// enough: it can exist and still give no adapter.
export async function adapterFound(): Promise<boolean> {
  const gpu = (navigator as { gpu?: Gpu }).gpu
  try {
    return (await gpu?.requestAdapter()) != null
  } catch {
    return false
  }
}
