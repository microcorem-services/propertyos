import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
};

export function Button({
  className = '',
  variant = 'primary',
  ...props
}: ButtonProps) {
  const variantClass =
    variant === 'secondary' ? ' bow-era-button-secondary' : '';
  return (
    <button
      className={`bow-era-button${variantClass} ${className}`.trim()}
      {...props}
    />
  );
}

export function Card({
  className = '',
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`bow-era-state ${className}`.trim()} {...props} />
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
}) {
  return (
    <div className="bow-era-heading">
      <p className="bow-era-eyebrow">{eyebrow}</p>
      <h1 className="bow-era-title">{title}</h1>
      <p className="bow-era-description">{description}</p>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="bow-era-state bow-era-state-center" role="status" aria-live="polite">
      <span className="bow-era-spinner" aria-hidden="true" />
      <p className="bow-era-state-copy">{label}</p>
    </div>
  );
}

export function ErrorMessage({
  title,
  children,
  action,
  variant = 'error',
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  variant?: 'auth' | 'error';
}) {
  return (
    <section
      className={`bow-era-state bow-era-message bow-era-${variant}`}
      role="alert"
    >
      <h2 className="bow-era-state-title">{title}</h2>
      <p className="bow-era-state-copy">{children}</p>
      {action}
    </section>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="bow-era-state-center">
      <h2 className="bow-era-state-title">{title}</h2>
      <p className="bow-era-state-copy">{children}</p>
    </Card>
  );
}

export function Wordmark() {
  return (
    <div className="bow-era-wordmark" aria-label="BOWERA by Microcorem">
      <span className="bow-era-mark" aria-hidden="true">B</span>
      <span>
        <span className="bow-era-brand-name">BOWERA</span>
        <span className="bow-era-brand-byline">BY MICROCOREM</span>
      </span>
    </div>
  );
}
