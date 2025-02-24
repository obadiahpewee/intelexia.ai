import type { Metadata } from 'next'
import { Geist, Zen_Dots } from 'next/font/google'
import { Toaster } from "@/components/ui/toaster"
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from "@/components/ui/tooltip"

import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const zenDots = Zen_Dots({
  variable: '--font-zen-dots',
  weight: ['400'],
  style: ['normal'],
  subsets: ['latin'],
  display: 'swap',
})

const metadataBase = process.env.NODE_ENV === 'production' 
  ? 'https://intelexia.ai' 
  : 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(metadataBase),
  title: 'intelexia.ai',
  description:
    'A free AI Deep Research tool to generate reports and presentations automatically or by manually selecting sources.',
  openGraph: {
    title: 'intelexia.ai',
    description: 'A free AI Deep Research tool to generate reports and presentations automatically or by manually selecting sources.',
    url: 'https://intelexia.ai',
    siteName: 'intelexia.ai',
    images: [
      {
        url: '/opengraph-image.png',
        width: 1200,
        height: 630,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'intelexia.ai',
    description: 'A free AI Deep Research tool to generate reports and presentations automatically or by manually selecting sources.',
    images: ['/opengraph-image.png'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en' suppressHydrationWarning>
      <body className={`${geistSans.variable} ${zenDots.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>      
    </html>
  )
}
