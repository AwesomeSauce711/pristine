import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 text-center">
      <p className="legend">404</p>
      <h1 className="mt-4 text-3xl font-semibold">Page not found</h1>
      <Link href="/" className="pill pill-primary mt-8">Back to Pristine</Link>
    </main>
  );
}
