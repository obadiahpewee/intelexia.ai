import { type Report } from '@/types'
import {
  Document,
  Paragraph,
  TextRun,
  AlignmentType,
  Packer,
  Header,
  Footer,
  PageNumber,
} from 'docx'
import jsPDF from 'jspdf'
import MarkdownIt from 'markdown-it'
import PptxGenJS from 'pptxgenjs'

const md = new MarkdownIt()

function processMarkdownContent(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    
    // Handle headings
    if (trimmed.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(4),
          size: 20,
          bold: true
        })],
        spacing: { before: 400, after: 200 },
      }));
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(3),
          size: 24,
          bold: true
        })],
        spacing: { before: 600, after: 400 },
      }));
    } else if (trimmed.startsWith('# ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(2),
          size: 28,
          bold: true
        })],
        spacing: { before: 800, after: 600 },
      }));
    }
    // Handle bullet points
    else if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(2),
          size: 24,
        })],
        bullet: { level: 0 },
        spacing: { before: 200, after: 200 },
      }));
    }
    // Handle numbered lists
    else if (/^\d+\.\s/.test(trimmed)) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.replace(/^\d+\.\s/, ''),
          size: 24,
        })],
        numbering: { level: 0, reference: 'numbered-list' },
        spacing: { before: 200, after: 200 },
      }));
    }
    // Handle regular paragraphs
    else if (trimmed.length > 0) {
      const textRuns: TextRun[] = [];
      
      // Find bold sections
      const boldRegex = /\*\*(.*?)\*\*/g;
      let match;
      let lastIndex = 0;
      
      while ((match = boldRegex.exec(trimmed)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          textRuns.push(new TextRun({
            text: trimmed.slice(lastIndex, match.index),
            size: 24,
          }));
        }
        // Add bold text
        textRuns.push(new TextRun({
          text: match[1],
          size: 24,
          bold: true,
        }));
        lastIndex = match.index + match[0].length;
      }
      
      // Add remaining text after last match
      if (lastIndex < trimmed.length) {
        textRuns.push(new TextRun({
          text: trimmed.slice(lastIndex),
          size: 24,
        }));
      }

      paragraphs.push(new Paragraph({
        children: textRuns,
        spacing: { before: 200, after: 200 },
        alignment: AlignmentType.JUSTIFIED,
      }));
    }
  });

  return paragraphs;
}

export async function generateDocx(report: Report): Promise<Buffer> {
  try {
    console.log(
      'Starting DOCX generation with report:',
      JSON.stringify(report, null, 2)
    )

    const doc = new Document({
      sections: [
        {
          properties: {},
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: " ",
                    }),
                  ],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  children: [
                    new TextRun('Page '),
                    new TextRun({
                      children: [PageNumber.CURRENT],
                    }),
                    new TextRun(' of '),
                    new TextRun({
                      children: [PageNumber.TOTAL_PAGES],
                    }),
                  ],
                  alignment: AlignmentType.CENTER,
                }),
              ],
            }),
          },
          children: [
            // Document title
            new Paragraph({
              children: [
                new TextRun({
                  text: report.title || 'Untitled Report',
                  size: 48,
                  bold: true,
                }),
              ],
              spacing: { before: 400, after: 800 },
              alignment: AlignmentType.CENTER,
            }),
            // Summary with increased spacing
            ...processMarkdownContent(report.summary || ''),
            // Sections with increased spacing
            ...report.sections.flatMap((section) => [
              new Paragraph({
                children: [
                  new TextRun({
                    text: section.title || '',
                    size: 32,
                    bold: true,
                  }),
                ],
                spacing: { before: 800, after: 400 },
                alignment: AlignmentType.LEFT,
              }),
              ...processMarkdownContent(section.content || ''),
            ]),
          ],
        },
      ],
    })

    console.log('Document instance created')

    try {
      console.log('Starting document packing')
      const buffer = await Packer.toBuffer(doc)
      console.log('Document packed successfully, buffer size:', buffer.length)
      return buffer
    } catch (packError) {
      console.error('Error packing document:', packError)
      throw packError
    }
  } catch (error) {
    console.error('Error in generateDocx:', error)
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      })
    }
    throw new Error(
      `Failed to generate DOCX: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    )
  }
}

export async function generatePptx(report: Report): Promise<Buffer> {
  try {
    const pptx = new PptxGenJS()
    
    // Add title slide
    const titleSlide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });
    titleSlide.addText(report.title, { 
      x: 0.5, 
      y: 1, 
      w: '90%', 
      h: 2,
      fontSize: 36,
      bold: true,
      align: 'center'
    });
    titleSlide.addText('Generated by intelexia.ai', {
      x: 0.5,
      y: 4.5,
      w: '90%',
      fontSize: 18,
      color: '666666',
      align: 'center'
    });

    // Add content slides
    report.sections.forEach(section => {
      const slide = pptx.addSlide()
      
      // Add section title
      slide.addText(section.title, {
        x: 0.5, y: 0.25, w: '90%', h: 0.8,
        fontSize: 24,
        bold: true
      })
      
      // Process content with bullet points and numbered lists
      const content = section.content.split('\n').reduce<PptxGenJS.TextProps[]>((acc, line) => {
        const trimmed = line.trim();
        
        // Handle numbered lists (1., 2., etc)
        if (/^\d+\./.test(trimmed)) {
          return [...acc, {
            text: trimmed.replace(/^\d+\./, '').trim(),
            options: {
              bullet: { 
                type: 'number',
                numberType: 'arabicPlain' as const,
              },
              // indent is valid but missing from types
              indentLevel: 0.5
            } satisfies PptxGenJS.TextPropsOptions
          }];
        }
        
        // Handle bullet points
        if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
          return [...acc, {
            text: trimmed.slice(1).trim(),
            options: { bullet: true } as PptxGenJS.TextPropsOptions
          }];
        }
        
        // Remove markdown bold syntax and apply formatting
        const textProps: PptxGenJS.TextProps[] = [];
        
        const boldRegex = /\*\*(.*?)\*\*/g;
        let match;
        let lastIndex = 0;
        
        while ((match = boldRegex.exec(trimmed)) !== null) {
          // Add text before match
          if (match.index > lastIndex) {
            textProps.push({
              text: trimmed.slice(lastIndex, match.index),
              options: {
                fontSize: 18,
                // @ts-expect-error - indent is valid but missing from types
                indent: 0.3,
              } satisfies PptxGenJS.TextPropsOptions
            });
          }
          // Add bold text
          textProps.push({
            text: match[1],
            options: {
              fontSize: 18,
              bold: true,
              // @ts-expect-error - indent is valid but missing from types
              indent: 0.3,
            } satisfies PptxGenJS.TextPropsOptions
          });
          lastIndex = boldRegex.lastIndex;
        }
        
        // Add remaining text after last match
        if (lastIndex < trimmed.length) {
          textProps.push({
            text: trimmed.slice(lastIndex),
            options: { 
              fontSize: 18,
              // @ts-expect-error - indent is valid but missing from types
              indent: 0.3,
            } satisfies PptxGenJS.TextPropsOptions
          });
        }
        
        return [...acc, ...textProps];
      }, []);

      // Add formatted content to slide
      if (content.length > 0) {
        slide.addText(content, {
          x: 0.5,
          y: 1.95,
          h: 2.0, // Increased height for better spacing
          w: '90%',
          fontSize: 18,
          lineSpacing: 24,
          // paraSpaceBefore: 8,
          // paraSpaceAfter: 8
        });
      }
    })

    // Generate buffer directly from the stream result
    const buffer = await pptx.stream();
    return Buffer.from(buffer as Uint8Array);
  } catch (error) {
    console.error('Error generating PPTX:', error)
    throw new Error('Failed to generate PowerPoint')
  }
}

export function generatePdf(report: Report): Buffer {
  try {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    })

    const pageWidth = doc.internal.pageSize.width
    const margin = 20
    const contentWidth = pageWidth - 2 * margin

    // Helper function to add text with proper line breaks and page management
    const addText = (
      text: string,
      y: number,
      fontSize: number,
      isBold: boolean = false,
      isJustified: boolean = false,
      isHTML: boolean = false
    ): number => {
      doc.setFontSize(fontSize)
      doc.setFont('helvetica', isBold ? 'bold' : 'normal')

      // If the text contains markdown, convert it to plain text
      let processedText = text
      if (isHTML) {
        // Remove HTML tags but preserve line breaks
        processedText = text
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<[^>]*>/g, '')
          // Handle markdown-style bold
          .replace(/\*\*(.*?)\*\*/g, (_, p1) => {
            doc.setFont('helvetica', 'bold')
            const result = p1
            doc.setFont('helvetica', isBold ? 'bold' : 'normal')
            return result
          })
          // Handle markdown-style italic
          .replace(/\*(.*?)\*/g, (_, p1) => {
            doc.setFont('helvetica', 'italic')
            const result = p1
            doc.setFont('helvetica', isBold ? 'bold' : 'normal')
            return result
          })
      }

      const lines = doc.splitTextToSize(processedText, contentWidth)
      const lineHeight = fontSize * 0.3527 // Convert pt to mm

      lines.forEach((line: string) => {
        if (y > 270) {
          doc.addPage()
          y = margin
        }

        // Handle bullet points
        if (line.trim().startsWith('•') || line.trim().startsWith('-')) {
          doc.text('•', margin, y)
          doc.text(line.trim().substring(1), margin + 5, y, {
            align: isJustified ? 'justify' : 'left',
            maxWidth: contentWidth - 5,
          })
        } else {
          doc.text(line, margin, y, {
            align: isJustified ? 'justify' : 'left',
            maxWidth: contentWidth,
          })
        }
        y += lineHeight + 1 // 1mm extra spacing between lines
      })

      return y + lineHeight // Return new Y position
    }

    // Start position
    let currentY = margin

    // Title
    currentY = addText(report.title, currentY, 24, true)
    currentY += 5 // Reduced from 10 to 5

    // Convert markdown to HTML for processing
    const summaryHtml = md.render(report.summary)
    currentY = addText(summaryHtml, currentY, 12, false, true, true)
    currentY += 3 // Reduced from 10 to 3

    // Sections
    report.sections.forEach((section) => {
      currentY += 2 // Reduced from 5 to 2

      // Section title
      currentY = addText(section.title, currentY, 16, true)
      currentY += 2 // Reduced from 5 to 2

      // Convert markdown to HTML for processing
      const contentHtml = md.render(section.content)
      currentY = addText(contentHtml, currentY, 12, false, true, true)
      currentY += 2 // Reduced from 5 to 2
    })

    // Add page numbers
    const pageCount = doc.internal.pages.length - 1
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text(`Page ${i} of ${pageCount}`, pageWidth / 2, 285, {
        align: 'center',
      })
    }

    return Buffer.from(doc.output('arraybuffer'))
  } catch (error) {
    console.error('Error generating PDF:', error)
    throw new Error('Failed to generate PDF')
  }
}
