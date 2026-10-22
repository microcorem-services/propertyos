import { NextResponse, type NextRequest } from 'next/server';
import { isPreviewRequestAllowed } from './lib/preview-route-policy';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPreviewRequestAllowed(pathname, request.method)) {
    return NextResponse.next();
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return NextResponse.json(
      { error: 'not_found', message: 'This preview has no active operations.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'not_found', message: 'API routes are disabled in this preview.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const unavailableUrl = request.nextUrl.clone();
  unavailableUrl.pathname = '/preview-unavailable';
  unavailableUrl.search = '';
  return NextResponse.redirect(unavailableUrl, 307);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
};
