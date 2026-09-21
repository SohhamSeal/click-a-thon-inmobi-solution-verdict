import type { Metadata } from 'next';
import { VerdictAI } from '@/components/VerdictAI';
import './globals.css';

export const metadata: Metadata = {
  title: 'Verdict \u2014 root cause console',
  description: 'Detection, localization and confidence for ad-tech metrics on ClickHouse',
};

/** Inline before paint — avoids next/script beforeInteractive client warning on App Router. */
const themeBootstrap = `(function(){try{var t=localStorage.getItem('verdict-theme');document.documentElement.dataset.theme=(t==='dark')?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script id="verdict-theme" dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        {children}
        {/* In the layout rather than the page so the bubble survives navigation and keeps
            its conversation, and so a route that fails to load still has somewhere to ask
            why. */}
        <VerdictAI />
      </body>
    </html>
  );
}
