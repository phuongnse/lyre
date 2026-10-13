// The hosts Hugging Face redirects the pinned model URLs to. The page's
// Content Security Policy allows only these and the pinned URLs' own host in
// its connect-src, and a unit test keeps the two the same. The models
// reference lists them (docs/reference/models.md#download-hosts).
export const REDIRECT_HOSTS = [
  'cas-bridge.xethub.hf.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'us.aws.cdn.hf.co',
] as const
