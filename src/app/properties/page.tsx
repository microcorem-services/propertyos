import Link from 'next/link';
import styles from '../preview.module.css';

export default function PropertiesUnavailable() {
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
          <p className={styles.eyebrow}>PROPERTY OPERATIONS</p>
          <span className={styles.unavailableMark} aria-hidden="true">—</span>
          <h1 id="unavailable-title">Properties are not connected yet</h1>
          <p>
            Property workflows are unavailable in this preview. No property service
            or data source is connected, and no records have been loaded.
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
