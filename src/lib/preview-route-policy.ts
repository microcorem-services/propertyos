const PREVIEW_DOCUMENT_PATHS = new Set([
  '/',
  '/properties',
  '/preview-unavailable',
]);

export function isPreviewRequestAllowed(pathname: string, method: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    PREVIEW_DOCUMENT_PATHS.has(pathname)
  );
}
