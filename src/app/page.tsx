import Link from 'next/link';
import styles from './preview.module.css';

const previewAreas = [
  {
    number: '01',
    title: 'Property operations',
    detail: 'Portfolio and property workflows are not connected in this preview.',
  },
  {
    number: '02',
    title: 'Organisation access',
    detail: 'Sign-in and organisation membership are not enabled here.',
  },
  {
    number: '03',
    title: 'Finance and reporting',
    detail: 'No invoices, balances, reports, or customer records are available.',
  },
];

export default function Home() {
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

        <section className={styles.hero} aria-labelledby="hero-title">
          <p className={styles.eyebrow}>PROPERTY OPERATIONS, THOUGHTFULLY CONNECTED</p>
          <h1 id="hero-title">A considered foundation for better property operations.</h1>
          <p className={styles.intro}>
            This is an early look at the BOWERA experience. The preview is intentionally
            disconnected from accounts, services, and property data.
          </p>
          <Link className={styles.button} href="/properties">
            Explore the preview <span aria-hidden="true">→</span>
          </Link>
        </section>

        <section className={styles.previewNotice} aria-label="Preview boundaries">
          <span className={styles.noticeIcon} aria-hidden="true">i</span>
          <p>
            <strong>Preview only.</strong> There is no sign-in, live data, or working
            business functionality in this environment.
          </p>
        </section>

        <section className={styles.areas} aria-labelledby="areas-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>A WORK IN PROGRESS</p>
            <h2 id="areas-title">Designed for the work ahead</h2>
          </div>
          <div className={styles.areaGrid}>
            {previewAreas.map((area) => (
              <article className={styles.areaCard} key={area.number}>
                <span className={styles.areaNumber}>{area.number}</span>
                <h3>{area.title}</h3>
                <p>{area.detail}</p>
                <span className={styles.status}>Not available in preview</span>
              </article>
            ))}
          </div>
        </section>

        <footer className={styles.footer}>
          <span>BOWERA · Development preview</span>
          <span>No customer or property data is shown.</span>
        </footer>
      </div>
    </main>
  );
}
