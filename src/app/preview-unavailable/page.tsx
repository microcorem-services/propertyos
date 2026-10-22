import Link from 'next/link';
import styles from '../preview.module.css';

export default function PreviewUnavailable() {
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <Link className={styles.wordmark} href="/" aria-label="BOWERA preview home">
            <span className={styles.mark} aria-hidden="true">B</span>
            <span>BOWERA</span>
          </Link>
          <span className={styles.previewBadge}>DEVELOPMENT PREVIEW</span>
        </header>

        <section className={styles.unavailable} aria-labelledby="unavailable-title">
          <p className={styles.eyebrow}>DEVELOPMENT PREVIEW</p>
          <span className={styles.unavailableMark} aria-hidden="true">—</span>
          <h1 id="unavailable-title">This area is not available in the preview</h1>
          <p>
            Business features and API endpoints are deliberately disabled here.
            This page has no connection to authentication, backend services, or
            customer data.
          </p>
          <Link className={styles.button} href="/">Return to preview home</Link>
        </section>

        <footer className={styles.footer}>
          <span>BOWERA · Development preview</span>
          <span>No customer or property data is shown.</span>
        </footer>
      </div>
    </main>
  );
}
