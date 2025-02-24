import { NextResponse } from 'next/server'
import { geminiFlashThinkingModel } from '@/lib/gemini'
import { reportContentRatelimit } from '@/lib/redis'
import { CONFIG } from '@/lib/config'
import { type Report, type Article } from '@/types'

const MAX_RETRIES = 2;

async function retryJsonParse(jsonMatch: string, retryCount = 0): Promise<any> {
  try {
    return JSON.parse(jsonMatch);
  } catch (error) {
    const parseError = error as Error;
    console.error(`JSON parsing error (attempt ${retryCount + 1}):`, parseError);
    console.log('Problematic JSON:', jsonMatch.substring(0, 200) + '...');
    
    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying JSON parse, attempt ${retryCount + 2}...`);
      
      // Add a small delay before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to clean the JSON string before parsing
      let cleanedJson = jsonMatch
        // Fix invalid escapes
        .replace(/\\(?!["\\/bfnrt])/g, '\\\\')
        // Fix unescaped quotes
        .replace(/(?<!\\)"/g, '\\"')
        // Fix line breaks and whitespace
        .replace(/[\n\r]+/g, '\\n')
        .replace(/\t/g, '\\t')
        // Remove BOM and other unicode markers
        .replace(/^\uFEFF/, '')
        // Remove control characters
        .replace(/[\u0000-\u001F]+/g, '')
        // Fix common markdown artifacts
        .replace(/```json\s*/, '')
        .replace(/\s*```\s*$/, '')
        // Handle potential trailing commas
        .replace(/,\s*([\]}])/g, '$1')
        // Ensure proper JSON structure
        .trim();

      // If the JSON doesn't start with { or [, wrap it
      if (!/^[\[{]/.test(cleanedJson)) {
        cleanedJson = '{' + cleanedJson;
      }
      if (!/[\]}]$/.test(cleanedJson)) {
        cleanedJson = cleanedJson + '}';
      }

      // Log the cleaned JSON for debugging
      console.log('Cleaned JSON:', cleanedJson.substring(0, 200) + '...');
        
      return retryJsonParse(cleanedJson, retryCount + 1);
    }
    
    throw new Error(`Failed to parse JSON after ${MAX_RETRIES + 1} attempts: ${parseError.message}`);
  }
}

export const maxDuration = 60

function generateSystemPrompt(
  selectedResults: Article[],
  userPrompt: string,
  citationStyle: string,
  wordCount: string
) {
  let citationInstructions = ''
  if (citationStyle === 'APA 7th Edition') {
    citationInstructions = `5. Use APA 7th edition in-text citations (Author, Year) when referencing sources
6. Include a References section at the end listing all cited sources in alphabetical order, formatted according to APA 7th edition guidelines`
  } else if (citationStyle === 'MLA 9th Edition') {
    citationInstructions = `5. Use MLA 9th edition in-text citations (Author Page) when referencing sources
6. Include a Works Cited section at the end listing all cited sources in alphabetical order, formatted according to MLA 9th edition guidelines`
  } else {
    // IEEE
    citationInstructions = `5. Use IEEE numerical citations [1] when referencing sources
6. Include a References section at the end listing all cited sources in numerical order of appearance, formatted according to IEEE guidelines`
  }

  let wordCountInstruction = ''
  if (wordCount !== 'N/A') {
    const target = parseInt(wordCount)
    const minWords = Math.floor(target * 0.9)
    const maxWords = Math.floor(target * 1.1)
    wordCountInstruction = `7. The report must be between ${minWords} and ${maxWords} words in length (excluding references/works cited section)`
  }

  return `You are a research assistant tasked with creating a comprehensive report based on deep search results.
The report should specifically address this request: "${userPrompt}"

Your report should:
${wordCountInstruction}
1. Have a clear title that reflects the specific analysis requested
2. Begin with a concise executive summary
3. Be organized into relevant sections based on the analysis requested
4. Use markdown formatting for emphasis, lists, and structure
${citationInstructions}
7. Maintain objectivity while addressing the specific aspects requested in the prompt
8. Compare and contrast the information from each source, noting areas of consensus or points of contention
9. Showcase key insights, important data, or innovative ideas

Here are the sources and their key findings:
${selectedResults.map((result, index) => `
${index + 1}. Source: ${result.title}
   URL: ${result.url}
   Content: ${result.content}
`).join('\n')}

Format the report as a JSON object with the following structure:
{
  "title": "Report title",
  "summary": "Executive summary (can include markdown)",
  "sections": [
    {
      "title": "Section title",
      "content": "Section content with markdown formatting"
    },
    {
      "title": "References",
      "content": "Formatted sources in ${citationStyle} (\\n separating each citation)"
    }
  ]
}

Use markdown formatting in the content to improve readability:
- Use **bold** for emphasis
- Use bullet points and numbered lists where appropriate
- Use headings and subheadings with # syntax
- Include code blocks if relevant
- Use > for quotations
- Use --- for horizontal rules where appropriate`
}

// Update the request body type handling
interface DeepReportRequest {
  learnings: string[]  // Add learnings field
  sources: Array<{
    id: string
    url: string
    name: string
  }>
  prompt: string
  model: string
  citationStyle?: string
  wordCount?: string
}

// Update the POST function parameters
export async function POST(request: Request) {
  try {
    const body = await request.json() as DeepReportRequest
    const {
      learnings,  // Add learnings destructuring
      sources,
      prompt,
      citationStyle = 'APA 7th Edition',
      wordCount = '1500',
      model = 'gemini-flash-thinking'
    } = body

    // Transform learnings into the expected article format
    const selectedResults: Article[] = learnings.map((learning, index) => ({
      url: sources[index]?.url || '',
      title: sources[index]?.name || `Learning ${index + 1}`,
      content: learning
    }))

    // Only check rate limit if enabled
    if (CONFIG.rateLimits.enabled) {
      const { success } = await reportContentRatelimit.limit('deep-report')
      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 }
        )
      }
    }

    const systemPrompt = generateSystemPrompt(
      selectedResults,
      prompt,
      citationStyle,
      wordCount
    )

    try {
      const result = await geminiFlashThinkingModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
        generationConfig: { maxOutputTokens: 8192 }
      })

      const response = result.response.text()

      // Extract JSON using regex
      const jsonMatch = response.match(/\{[\s\S]*\}/)?.[0]
      if (!jsonMatch) {
        console.error('No JSON found in response')
        return NextResponse.json(
          { error: 'Invalid report format' },
          { status: 500 }
        )
      }

      try {
        const reportData = await retryJsonParse(jsonMatch) as Report
        // Add sources to the report data
        reportData.sources = sources
        
        console.log('Generated deep search report:', reportData)
        return NextResponse.json(reportData)
      } catch (parseError) {
        console.error('Final JSON parsing error:', parseError)
        return NextResponse.json(
          { error: 'Failed to parse report format after retries' },
          { status: 500 }
        )
      }
    } catch (error) {
      console.error('Model generation error:', error)
      return NextResponse.json(
        { error: 'Failed to generate report content' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Report generation error:', error)
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 }
    )
  }
} 