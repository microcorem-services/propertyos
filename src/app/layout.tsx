import type { Metadata } from 'next';
import './styles.css';
import './phase2.css';
export const metadata: Metadata = {title:'PropertyOS | Microcorem',description:'Property asset management demonstration by Microcorem'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>}
