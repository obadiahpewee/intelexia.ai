import { NextResponse } from 'next/server'
import {
  geminiModel,
  geminiFlashModel,
  geminiFlashThinkingModel,
} from '@/lib/gemini'
import { reportContentRatelimit } from '@/lib/redis'
import { type Article } from '@/types'
import { CONFIG } from '@/lib/config'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

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

export const maxDuration = 240 // 4 minutes changed from 60s

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
})

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
})

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
})

type PlatformModel =
  | 'google__gemini-flash'
  | 'google__gemini-flash-thinking'
  | 'google__gemini-exp'
  | 'gpt-4o'
  | 'o1-mini'
  | 'o1'
  | 'sonnet-3.5'
  | 'haiku-3.5'
  | 'deepseek__chat'
  | 'deepseek__reasoner'

type DeepSeekMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

async function generateWithGemini(systemPrompt: string, model: string, maxTokens: number) {
  console.log('Calling Gemini model:', model, 'with maxOutputTokens:', maxTokens);
  const generationConfig = { maxOutputTokens: maxTokens };
  if (model === 'gemini-flash-thinking') {
    const result = await geminiFlashThinkingModel.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: systemPrompt }]
      }],
      generationConfig
    })
    return result.response.text()
  } else if (model === 'gemini-exp') {
    const result = await geminiModel.generateContent(systemPrompt)
    return result.response.text()
  } else {
    const result = await geminiFlashModel.generateContent(systemPrompt)
    return result.response.text()
  }
}

async function generateWithOpenAI(systemPrompt: string, model: string, maxTokens: number) {
  console.log('Calling OpenAI model:', model, 'with max_tokens:', maxTokens);
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: systemPrompt,
      },
    ],
    max_tokens: maxTokens,
  })
  return response.choices[0].message.content
}

async function generateWithDeepSeek(systemPrompt: string, model: string, maxTokens: number) {
  console.log('Calling DeepSeek model:', model, 'with max_tokens:', maxTokens);
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // Initial message to start the conversation
      const messages: DeepSeekMessage[] = [
        {
          role: 'user',
          content: systemPrompt,
        },
      ]

      const response = await deepseek.chat.completions.create({
        model,
        messages: messages as any,
        max_tokens: maxTokens,
      })

      // Get the initial response
      const content = response.choices[0].message.content || ''

      // For the reasoner model, we can get additional reasoning content
      let reasoning = ''
      const messageWithReasoning = response.choices[0].message as any
      if (
        model === 'deepseek-reasoner' &&
        messageWithReasoning.reasoning_content
      ) {
        reasoning = messageWithReasoning.reasoning_content
        console.log('DeepSeek reasoning:', reasoning)
      }

      return content
    } catch (error) {
      retryCount++;
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
        console.log(`DeepSeek API error (attempt ${retryCount}/${maxRetries}):`, error);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('DeepSeek API error after all retries:', error);
        throw error;
      }
    }
  }
  throw new Error('Failed to get response from DeepSeek API after all retries');
}

async function generateWithAnthropic(systemPrompt: string, model: string, maxTokens: number) {
  console.log('Calling Anthropic model:', model, 'with max_tokens:', maxTokens);
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    temperature: 0.9,
    messages: [
      {
        role: 'user',
        content: systemPrompt,
      },
    ],
  })
  return response.content[0].text || ''
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      selectedResults,
      sources,
      prompt,
      platformModel = 'google-gemini-flash',
      citationStyle = 'APA 7th Edition',
      contentType = 'report',
      slideCount,
      wordCount,
      maxTokens = 8192 // Increased default token count from 4620 to 8192
    } = body as {
      selectedResults: Article[]
      sources: any[]
      prompt: string
      platformModel: PlatformModel
      citationStyle?: string
      contentType?: 'report' | 'presentation'
      slideCount?: string
      wordCount?: string
      maxTokens?: number
    }

    // Validate presentation parameters
    const slideCountNum = contentType === 'presentation' 
      ? Math.min(Number(slideCount) || 10, 25) 
      : undefined;
    
    // Validate report parameters
    const wordCountNum = contentType === 'report'
      ? Math.min(Number(wordCount) || 1500, 3000)
      : undefined;

    // Only check rate limit if enabled
    if (CONFIG.rateLimits.enabled) {
      const { success } = await reportContentRatelimit.limit('report')
      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 }
        )
      }
    }

    // Check if selected platform is enabled
    const platform = platformModel.split('__')[0]
    const model = platformModel.split('__')[1]

    const platformConfig =
      CONFIG.platforms[platform as keyof typeof CONFIG.platforms]
    if (!platformConfig?.enabled) {
      return NextResponse.json(
        { error: `${platform} platform is not enabled` },
        { status: 400 }
      )
    }

    // Check if selected model exists and is enabled
    const modelConfig = (platformConfig as any).models[model]
    if (!modelConfig) {
      return NextResponse.json(
        { error: `${model} model does not exist` },
        { status: 400 }
      )
    }
    if (!modelConfig.enabled) {
      return NextResponse.json(
        { error: `${model} model is disabled` },
        { status: 400 }
      )
    }

    console.log('Received generation parameters:', {
      contentType,
      slideCount: slideCountNum ?? 'N/A',
      citationStyle,
      wordCount: wordCountNum ?? 'N/A', 
      model: platformModel
    });

    const generateSystemPrompt = (articles: Article[], userPrompt: string, citationStyle: string, wordCount: string, contentType: 'report' | 'presentation' = 'report', slideCount: number = 10) => {
      if (contentType === 'presentation') {
        let citationInstructions = '';
      if (citationStyle === 'APA 7th Edition') {
        citationInstructions = `Use APA 7th edition in-text citations (Author, Year) when referencing sources
- Include full references in APA format`;
      } else if (citationStyle === 'MLA 9th Edition') {
        citationInstructions = `Use MLA 9th edition in-text citations (Author Page) when referencing sources
- Include works cited in MLA format`;
      } else { // IEEE
        citationInstructions = `Use IEEE numerical citations [1] when referencing sources
- Include references in numerical order`;
      }

      return `You are a research assistant tasked with creating a structured presentation based on multiple sources.
The presentation should specifically address this request: "${userPrompt}"

Your presentation must follow this structure using the sections array:

1. Title Section:
   - Presentation title reflecting the analysis topic
   - Subtitle stating "Generated by intelexia.ai"

2. Summary Section:
   - 3-4 bullet points summarizing key findings
   - Focus on main conclusions and insights

3. Overview Section:
   - List of all topics covered (one per content section)
   - Serves as table of contents

4. Content Sections: ${slideCount} sections total
   - Each section covers one key topic from the overview
   - Use 3-6 bullet points per section
   - Highlight important data/contrasting viewpoints
   - ${citationInstructions}

5. Conclusion Section:
   - Reiterates key points from summary
   - Provides final recommendations/insights

6. References Section:
   - List all sources in ${citationStyle} format
   - Include full citations with URLs

Formatting rules:
   - Use identical markdown formatting to reports:
     * + for bullet points
     * **Bold** for key terms
     * \n for new lines
     * Proper JSON escaping for special characters

Analyze these sources:
${articles.map(a => `
Title: ${a.title}
URL: ${a.url}
Content: ${a.content}`).join('\n')}

Format as JSON with this exact structure:
{
  "title": "Presentation Title",
  "summary": "Slide Presentation",
  "sections": [
    {
      "title": "Title Slide",
      "content": "Presentation Title\\nGenerated by intelexia.ai"
    },
    {
      "title": "Executive Summary", 
      "content": "+ **Key finding 1**\\n+ **Key finding 2**\\n+ **Key finding 3**"
    },
    {
      "title": "Overview",
      "content": "1. Topic 1\\n2. Topic 2\\n3. Topic 3\\n4. Topic 4"
    },
    // ${slideCount} content sections...
    {
      "title": "Conclusion",
      "content": "+ *Restated key insight 1*\\n+ **Final recommendations**"
    },
    {
      "title": "References",
      "content": "Formatted sources in ${citationStyle} (\n separating each citation)"
    }
  ]
}

Important: The JSON must contain exactly ${slideCount + 4} slides total (title + summary + overview + ${slideCount} content + conclusion + references)`;
      }
      let citationInstructions = '';
      if (citationStyle === 'APA 7th Edition') {
        citationInstructions = `5. Use APA 7th edition in-text citations (Author, Year) when referencing sources
6. Include a References section at the end listing all cited sources in alphabetical order, formatted according to APA 7th edition guidelines`;
      } else if (citationStyle === 'MLA 9th Edition') {
        citationInstructions = `5. Use MLA 9th edition in-text citations (Author Page) when referencing sources
6. Include a Works Cited section at the end listing all cited sources in alphabetical order, formatted according to MLA 9th edition guidelines`;
      } else { // IEEE
        citationInstructions = `5. Use IEEE numerical citations [1] when referencing sources
6. Include a References section at the end listing all cited sources in numerical order of appearance, formatted according to IEEE guidelines`;
      }

      let wordCountInstruction = '';
      if (wordCount !== 'N/A') {
        const target = parseInt(wordCount);
        const minWords = Math.floor(target * 0.9);
        const maxWords = Math.floor(target * 1.1);
        wordCountInstruction = `7. The report must be between ${minWords} and ${maxWords} words in length (excluding references/works cited section)`;
      }

      return `You are a research assistant tasked with creating a comprehensive report based on multiple sources. 
The report should specifically address this request: "${userPrompt}"

Your report should:
${wordCountInstruction}
1. Have a clear title that reflects the specific analysis requested
2. Begin with a concise executive summary
3. Be organized into relevant sections based on the analysis requested
4. Use markdown formatting for emphasis, lists, and structure
${citationInstructions}
7. Maintain objectivity while addressing the specific aspects requested in the prompt
8. Compare and contrast the information from each source, noting areas of consensus or points of contention. 
9. Showcase key insights, important data, or innovative ideas.

Here are the source articles to analyze:

${articles
  .map(
    (article) => `
Title: ${article.title}
URL: ${article.url}
Content: ${article.content}
---
`
  )
  .join('\n')}

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
      "content": "Formatted sources in ${citationStyle} (\n separating each citation)"
    }
  ]
}

Use markdown formatting in the content to improve readability:
- Use **bold** for emphasis
- Use bullet points and numbered lists where appropriate
- Use headings and subheadings with # syntax
- Include code blocks if relevant
- Use > for quotations
- Use --- for horizontal rules where appropriate

Important: Do not use phrases like "Source 1" or "According to Source 2". Instead, integrate the information naturally into the narrative or reference sources by their titles when necessary.`
    }

    let systemPrompt = generateSystemPrompt(
      selectedResults,
      prompt,
      citationStyle,
      wordCountNum?.toString() || 'N/A',  // Use validated numeric value
      contentType,
      slideCountNum || 10 // Use validated presentation slide count
    )
    
    // Add strict slide count validation
    if (contentType === 'presentation') {
      const slideCountNum = Number(slideCount) || 10
      systemPrompt = systemPrompt.replace(/\$\{slideCount\}/g, slideCountNum.toString())
    }

    // console.log('Sending prompt to model:', systemPrompt)
    console.log('Model:', model)

    try {
      let response: string | null = null
      switch (model) {
        case 'gemini-flash':
          response = await generateWithGemini(systemPrompt, 'gemini-flash', maxTokens || 8192)
          break
        case 'gemini-flash-thinking':
          response = await generateWithGemini(
            systemPrompt,
            'gemini-flash-thinking',
            maxTokens || 8192
          )
          break
        case 'gemini-exp':
          response = await generateWithGemini(systemPrompt, 'gemini-exp', maxTokens || 8192)
          break
        case 'gpt-4o':
          response = await generateWithOpenAI(systemPrompt, 'gpt-4o', maxTokens)
          break
        case 'o1-mini':
          response = await generateWithOpenAI(systemPrompt, 'o1-mini', maxTokens)
          break
        case 'o1':
          response = await generateWithOpenAI(systemPrompt, 'o1', maxTokens)
          break
        case 'sonnet-3.5':
          response = await generateWithAnthropic(
            systemPrompt,
            'claude-3-5-sonnet-latest',
            maxTokens
          )
          break
        case 'haiku-3.5':
          response = await generateWithAnthropic(
            systemPrompt,
            'claude-3-5-haiku-latest',
            maxTokens
          )
          break
        case 'chat':
          response = await generateWithDeepSeek(systemPrompt, 'deepseek-chat', maxTokens)
          break
        case 'reasoner':
          response = await generateWithDeepSeek(
            systemPrompt,
            'deepseek-reasoner',
            maxTokens
          )
          break
        default:
          throw new Error('Invalid platform/model combination')
      }

      if (!response) {
        throw new Error('No response from model')
      }

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
        const reportData = await retryJsonParse(jsonMatch)
        // Add sources to the report data
        reportData.sources = sources
        console.log('Parsed report data:', reportData)
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
