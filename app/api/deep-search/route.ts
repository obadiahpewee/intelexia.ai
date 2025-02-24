import { NextResponse } from 'next/server'
import { search, SafeSearchType } from 'duck-duck-scrape'
import { searchRatelimit, fetchContentRatelimit } from '@/lib/redis'
import { CONFIG } from '@/lib/config'
import { geminiFlashThinkingModel } from '@/lib/gemini'
// import { z } from 'zod' //commented out zod never used in npm run build 
import pLimit from 'p-limit'
import { compact } from 'lodash'
import axios from 'axios'

// Reduce concurrency
const ConcurrencyLimit = 1//change from 2 to 1

// System prompt for research consistency
// commented out system prompt never used in npm run build 
// const systemPrompt = () => {
//   const now = new Date().toISOString()
//   return `You are an expert researcher. Today is ${now}. Follow these instructions when responding:
//   - You may be asked to research subjects that is after your knowledge cutoff, assume the user is right when presented with news.
//   - The user is a highly experienced analyst, no need to simplify it, be as detailed as possible and make sure your response is correct.
//   - Be highly organized.
//   - Suggest solutions that I didn't think about.
//   - Be proactive and anticipate my needs.
//   - Treat me as an expert in all subject matter.
//   - Mistakes erode my trust, so be accurate and thorough.
//   - Provide detailed explanations, I'm comfortable with lots of detail.
//   - Value good arguments over authorities, the source is irrelevant.
//   - Consider new technologies and contrarian ideas, not just the conventional wisdom.
//   - You may use high levels of speculation or prediction, just flag it for me.`
// }

type SerpQuery = {
  query: string
  researchGoal: string
}

// Generate SERP queries using AI
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string
  numQueries?: number
  learnings?: string[]
}): Promise<SerpQuery[]> {
  console.log(`Generating SERP queries for: "${query}", max queries: ${numQueries}`)
  
  const prompt = `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other. Return the response in JSON format with a "queries" array containing objects with "query" and "researchGoal" properties: <prompt>${query}</prompt>\n\n${
    learnings
      ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
          '\n'
        )}`
      : ''
  }`

  console.log('Sending prompt to Gemini:', prompt)

  const aiResult = await geminiFlashThinkingModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 }
  })

  const response = aiResult.response.text()
  console.log('Received response from Gemini:', response)
  
  try {
    // Extract JSON from markdown code block if present
    const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || response.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) {
      console.error('No JSON found in response')
      throw new Error('Invalid response format')
    }

    const jsonStr = jsonMatch[1]
    console.log('Extracted JSON:', jsonStr)

    const parsed = JSON.parse(jsonStr)
    if (!parsed.queries || !Array.isArray(parsed.queries)) {
      console.error('Invalid queries format:', parsed)
      throw new Error('Invalid queries format')
    }

    const queries = parsed.queries.slice(0, numQueries)
    console.log('Generated queries:', queries)
    return queries
  } catch (e) {
    console.error('Failed to parse AI response:', e)
    throw new Error('Failed to generate search queries')
  }
}

type ProcessedResult = {
  learnings: string[]
  followUpQuestions: string[]
}

// Add SearchResponse type definition at the top
type SearchResponse = {
  data: Array<{
    url: string
    markdown: string
  }>
}

// Add DuckDuckScrape result type at the top
interface DuckDuckResult {
  url: string
  title: string
  description: string
}

// Update DuckDuckScrape search with rate limiting
async function safeDuckDuckSearch(query: string): Promise<any> {
  if (CONFIG.rateLimits.enabled) {
    const { success } = await searchRatelimit.limit(query)
    if (!success) {
      throw new Error('DuckDuckGo search rate limit exceeded')
    }
  }

  // Add artificial delay to avoid triggering DDG's anti-bot
  await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000))
  
  return search(query, {
    safeSearch: SafeSearchType.MODERATE,
    offset: 0
  })
}

// Implement global rate limit tracking
let totalJinaRequests = 0;
setInterval(() => { totalJinaRequests = 0 }, 60000);

// Update Jina content fetch with rate limiting
async function fetchJinaContent(url: string): Promise<string> {
  if (totalJinaRequests >= CONFIG.rateLimits.contentFetch) {
    throw new Error('Global Jina rate limit exceeded');
  }
  totalJinaRequests++;

  if (CONFIG.rateLimits.enabled) {
    const { success } = await fetchContentRatelimit.limit(url)
    if (!success) {
      throw new Error('Jina AI content fetch rate limit exceeded')
    }
  }

  try {
    const response = await axios.get(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      timeout: 15000,
      responseType: 'text'
    })
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      console.warn(`Jina AI rate limit hit for ${url}`)
      throw new Error('Jina AI content fetch rate limit exceeded')
    }
    throw error
  }
}

// Add retry logic for DuckDuckScrape searches
async function executeDuckDuckSearchWithRetry(query: string): Promise<any> {
  const maxRetries = 3;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await safeDuckDuckSearch(query);
    } catch (error) {
      if (error instanceof Error && error.message.includes('rate limit')) {
        const delay = Math.pow(2, retries) * 1000;
        console.log(`Retrying DuckDuckGo search in ${delay}ms (attempt ${retries + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
  throw new Error(`DuckDuckGo search failed after ${maxRetries} retries`);
}

// Update content fetching with retry logic
async function fetchJinaContentWithRetry(url: string): Promise<string> {
  // Add initial delay
  await new Promise(resolve => setTimeout(resolve, 4500 + Math.random() * 2000));

  const maxRetries = 2;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await fetchJinaContent(url);
    } catch (error) {
      if (error instanceof Error && error.message.includes('rate limit')) {
        // Change to random delay between 3-8 seconds
        const delay = 3000 + Math.random() * 5000;
        console.log(`Retrying Jina fetch in ${delay}ms (attempt ${retries + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Jina content fetch failed after ${maxRetries} retries`);
}

// Fix type in processSerpResult parameters
async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string
  result: SearchResponse  // Now using our defined type
  numLearnings?: number
  numFollowUpQuestions?: number
}): Promise<ProcessedResult> {
  const contents = compact(result.data.map(item => item.markdown))
  console.log(`Ran ${query}, found ${contents.length} contents`)

  const prompt = `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings and follow-up questions. Return the response in JSON format with a "learnings" array (max ${numLearnings} items) and a "followUpQuestions" array (max ${numFollowUpQuestions} items). The learnings should be concise and information-dense, including any entities, metrics, numbers, or dates.

Contents:
${contents.map((content: string) => `<content>\n${content}\n</content>`).join('\n')}

Return your response in this exact JSON format:
{
  "learnings": [
    "Learning 1",
    "Learning 2",
    "Learning 3"
  ],
  "followUpQuestions": [
    "Question 1?",
    "Question 2?",
    "Question 3?"
  ]
}`

  const aiResult = await geminiFlashThinkingModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 }
  })

  const response = aiResult.response.text()
  console.log('Received response from Gemini for SERP processing:', response)

  try {
    // Extract JSON from markdown code block if present
    const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || response.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) {
      console.error('No JSON found in response')
      throw new Error('Invalid response format')
    }

    const jsonStr = jsonMatch[1]
    console.log('Extracted JSON:', jsonStr)

    const parsed = JSON.parse(jsonStr)
    if (!parsed.learnings || !Array.isArray(parsed.learnings) || !parsed.followUpQuestions || !Array.isArray(parsed.followUpQuestions)) {
      console.error('Invalid response structure:', parsed)
      throw new Error('Invalid response structure')
    }

    return {
      learnings: parsed.learnings.slice(0, numLearnings),
      followUpQuestions: parsed.followUpQuestions.slice(0, numFollowUpQuestions)
    }
  } catch (e) {
    console.error('Failed to parse AI response:', e)
    throw new Error('Failed to process search results')
  }
}

type ResearchResult = {
  learnings: string[]
  visitedUrls: string[]
  errors: string[]
}

// Main deep research function
async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
}: {
  query: string
  breadth: number
  depth: number
  learnings?: string[]
  visitedUrls?: string[]
}): Promise<ResearchResult> {
  console.log(`Starting deep research with query: "${query}", depth: ${depth}, breadth: ${breadth}`)
  
  const errors: string[] = []
  let serpQueries: SerpQuery[] = [] // Declare outside try block

  try {
    serpQueries = await generateSerpQueries({
      query,
      learnings,
      numQueries: breadth,
    })
    console.log('Generated SERP queries:', serpQueries)
  } catch (e) {
    throw new Error('Failed to generate initial search queries')
  }

  const limit = pLimit(ConcurrencyLimit)

  const results = await Promise.all(
    serpQueries.map((serpQuery: SerpQuery) =>
      limit(async () => {
        try {
          console.log(`Searching DuckDuckScrape for query: "${serpQuery.query}"`)
          const searchResults = await executeDuckDuckSearchWithRetry(serpQuery.query) as {
            results: DuckDuckResult[]
          }

          // Get first 5 results and fetch their content
          const limitedResults: DuckDuckResult[] = searchResults.results.slice(0, 5)
          console.log(`Found ${limitedResults.length} results for "${serpQuery.query}"`)

          // Fetch content for all results using Jina
          const contentPromises = limitedResults.map(async (result: DuckDuckResult) => {
            try {
              return {
                url: result.url,
                markdown: await fetchJinaContentWithRetry(result.url)
              }
            } catch (error) {
              console.error(`Skipping ${result.url}: ${error instanceof Error ? error.message : 'Unknown error'}`)
              return null
            }
          })

          const contents = (await Promise.all(contentPromises)).filter((item): item is { url: string, markdown: string } => item !== null)
          console.log(`Successfully fetched ${contents.length} contents for "${serpQuery.query}"`)

          // Process results
          const newUrls = contents.map(item => item.url)
          const newBreadth = Math.ceil(breadth / 2)
          const newDepth = depth - 1

          const processedResult = await processSerpResult({
            query: serpQuery.query,
            result: { data: contents } as SearchResponse,
            numFollowUpQuestions: newBreadth,
          })

          const allLearnings = [...learnings, ...processedResult.learnings]
          const allUrls = [...visitedUrls, ...newUrls]

          if (newDepth > 0) {
            const nextQuery = `
              Previous research goal: ${serpQuery.researchGoal}
              Follow-up research directions: ${processedResult.followUpQuestions.join('\n')}
            `.trim()

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
            })
          }

          return {
            learnings: allLearnings,
            visitedUrls: allUrls,
            errors: []
          }
        } catch (error) {
          const errorMsg = `Failed to process query "${serpQuery.query}": ${error instanceof Error ? error.message : 'Unknown error'}`
          console.error(errorMsg)
          errors.push(errorMsg)
          return {
            learnings: [],
            visitedUrls: [],
            errors: [errorMsg]
          }
        }
      })
    )
  )

  // Aggregate results with error handling
  const finalLearnings = [...new Set(results.flatMap((r: ResearchResult) => r.learnings))]
  const finalUrls = [...new Set(results.flatMap((r: ResearchResult) => r.visitedUrls))]
  const allErrors = [...errors, ...results.flatMap((r: ResearchResult) => r.errors || [])]

  console.log('Deep research completed:', { 
    totalLearnings: finalLearnings.length,
    totalUrls: finalUrls.length,
    totalErrors: allErrors.length
  })
  
  return {
    learnings: finalLearnings,
    visitedUrls: finalUrls,
    errors: allErrors
  }
}

// API route handler
export async function POST(request: Request) {
  let learnings: string[] = []
  let visitedUrls: string[] = []
  
  try {
    const body = await request.json()
    const { query, searchDepth = 2, searchBreadth = 4 } = body

    console.log('Deep search request received:', {
      query,
      searchDepth,
      searchBreadth
    })

    if (!query) {
      console.error('No query provided')
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      )
    }

    // Only check rate limit if enabled
    if (CONFIG.rateLimits.enabled) {
      console.log('Checking rate limit...')
      const { success } = await searchRatelimit.limit(query)
      if (!success) {
        console.error('Rate limit exceeded')
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 }
        )
      }
    }

    try {
      console.log('Starting deep research...')
      const researchResult = await deepResearch({
        query,
        depth: searchDepth,
        breadth: searchBreadth,
      })
      learnings = researchResult.learnings
      visitedUrls = researchResult.visitedUrls
      const errors = researchResult.errors

      const response = {
        webPages: {
          value: visitedUrls.map((url, index) => ({
            id: `deep-${Date.now()}-${index}`,
            url,
            name: url,
            snippet: learnings[index] || 'No learning available',
          }))
        },
        learnings,
        errors
      }

      console.log('Deep search completed successfully:', {
        resultsCount: visitedUrls.length,
        learningsCount: learnings.length,
        errorCount: errors.length
      })
      
      // Return 200 even with errors as long as some learnings exist
      return NextResponse.json(response)
    } catch (error) {
      console.error('Deep search error:', error)
      // Declare variables outside the if block
      const errorLearnings = learnings || []
      const errorUrls = visitedUrls || []
      
      if (errorLearnings.length > 0) {
        return NextResponse.json({
          webPages: {
            value: errorUrls.map((url: string, index: number) => ({
              id: `deep-${Date.now()}-${index}`,
              url,
              name: url,
              snippet: errorLearnings[index] || 'No learning available',
            }))
          },
          learnings: errorLearnings,
          errors: [error instanceof Error ? error.message : 'Unknown error']
        })
      }
      return NextResponse.json(
        { error: 'Failed to perform deep search' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('API error:', error)
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400 }
    )
  }
} 