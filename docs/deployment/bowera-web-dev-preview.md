# BOWERA development preview

## Purpose and boundaries

This is a UI-only preview built from the repository root-level Next.js application.
Only `/`, `/properties`, and the static unavailable-state page are accessible.
Other page routes are redirected to the unavailable state, and every `/api` route
is blocked before reaching its handler. Non-read-only requests are rejected. This
boundary is implemented in `src/middleware.ts` using the Node.js middleware
runtime (not Edge middleware), and its route policy has focused tests.

The preview pages do not call the legacy Property API or any backend. They do not
authenticate users, connect to Cognito, DynamoDB, a database, or other BOWERA
services, or present sample portfolio/customer records. The navigation and
unavailable states are intentionally honest about unfinished functionality.
Amplify password protection is an additional gate to the preview site, not a
replacement for application authentication or API authorization.

## Amplify Hosting setup

- Connect a dedicated repository branch named `preview/bowera-web-dev`. Do not
  connect `main` or enable production branch deployments for this preview.
- Use the repository root as the app root; this is the single root-level Next.js
  application, not `apps/web`.
- Use the committed root `amplify.yml`. It selects the managed Node 22 runtime,
  rejects versions below 22.12, installs the lockfile exactly with `npm ci`,
  runs `npm run lint` and `npm run build`, then publishes `.next`.
- Enable password-based access control for the preview branch before sharing its
  URL. Store access credentials only in Amplify's access-control settings; never
  commit them or put them in frontend environment variables.
- Do not configure backend URLs, Cognito settings, AWS credentials, secrets, or
  `NEXT_PUBLIC_*` service endpoints. The preview needs no application
  environment variables.
- Disable automatic deployments initially. After explicit approval, enable
  builds only for `preview/bowera-web-dev`; verify the Amplify branch mapping
  before each change. Protect `main` with required review and checks, and do not
  use preview changes as a reason to deploy production.
- Review build logs for the Node version and successful lint/build before
  granting access. Do not treat a successful build as evidence that any backend
  is secure or production-ready.

AWS documents Amplify Hosting compute support for Next.js 12 through 15,
including middleware, while noting that Edge middleware is unsupported. The app
uses Next.js 15.5 and explicitly selects the Node.js middleware runtime. Confirm
the deployed Amplify app uses Hosting compute and that the selected region's
managed Node.js 22 runtime satisfies the build's 22.12 minimum before setup.
This configuration performs no cloud access or deployment by itself.

## Future custom domain

`dev.bowera.org` is a later, separately approved step. First confirm domain
ownership, the intended AWS account and `eu-west-2` region, and the exact
Amplify-generated DNS records. Add only the approved development subdomain
mapping and certificate validation records; do not change the apex domain or
production DNS. Keep password protection enabled after mapping and verify TLS,
the expected preview branch, and route restrictions before sharing the domain.

## Rollback

To stop the preview, first disable its branch auto-build and remove or disable
preview password access as appropriate. Then disable the Amplify branch or app
and remove only the approved `dev.bowera.org` mapping/DNS records, if they were
created. Preserve `main`, production branch mappings, apex DNS, and unrelated
AWS resources. Rollback must not alter backend services because none are part
of this preview.

## Review boundary

This change prepares source and build configuration only. It does not create an
Amplify app, change AWS, configure DNS, set up credentials, or publish a build.
These operations require separate product-owner approval and verification of
the dedicated non-production AWS account.
