import { NextResponse } from 'next/server'
import { searchRatelimit } from '@/lib/redis'
import { CONFIG } from '@/lib/config'
import { search, SafeSearchType } from 'duck-duck-scrape'
import axios from 'axios'

interface SearchRequest {
  query: string
  searchDepth?: string
  searchType?: string
}

interface SemanticScholarPaper {
  paperId: string
  title: string
  abstract: string
  url: string
  venue: string
  year: number
  authors: Array<{ name: string }>
}

async function searchSemanticScholar(query: string): Promise<SemanticScholarPaper[]> {
  try {
    const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    }
    
    // Only add API key if it exists
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }

    const response = await axios.get('https://api.semanticscholar.org/graph/v1/paper/search', {
      params: {
        query,
        limit: 60,
        fields: 'paperId,title,abstract,url,venue,year,authors'
      },
      headers,
      timeout: 10000 // 10 second timeout
    })

    // Add delay if no API key to respect rate limits (100 requests per 5 minutes)
    if (!apiKey) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
    }

    return response.data.data || []
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        console.error('Rate limit exceeded for Semantic Scholar API')
        throw new Error('Academic search rate limit exceeded. Please try again in a few minutes.')
      } else if (error.code === 'ECONNABORTED') {
        console.error('Semantic Scholar API timeout')
        throw new Error('Academic search timed out. Please try again.')
      } else if (error.response?.status === 503 || error.response?.status === 502) {
        console.error('Semantic Scholar API service unavailable')
        throw new Error('Academic search service temporarily unavailable. Please try again later.')
      }
    }
    console.error('Semantic Scholar API error:', error)
    throw new Error('Failed to fetch academic results. Please try again.')
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { query, searchDepth = 'light', searchType = 'general' }: SearchRequest = body

    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      )
    }

    if (CONFIG.rateLimits.enabled) {
      const { success } = await searchRatelimit.limit(query)
      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 }
        )
      }
    }

    // Explicitly check searchType to determine which search to use
    if (searchType === 'academic') {
      try {
        const papers = await searchSemanticScholar(query)
        
        if (!papers || papers.length === 0) {
          return NextResponse.json({
            webPages: {
              value: []
            },
            message: 'No academic results found. Try modifying your search terms or switching to general search.'
          })
        }

        return NextResponse.json({
          webPages: {
            value: papers.map(paper => ({
              id: paper.paperId,
              url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
              name: paper.title,
              snippet: paper.abstract || 'No abstract available',
              metadata: {
                venue: paper.venue,
                year: paper.year,
                authors: paper.authors.map(a => a.name).join(', ')
              }
            }))
          }
        })
      } catch (error) {
        console.error('Academic search error:', error)
        // Return a 200 response with empty results and an error message instead of failing
        return NextResponse.json({
          webPages: {
            value: []
          },
          error: error instanceof Error ? error.message : 'Failed to fetch academic results'
        })
      }
    } else if (searchType === 'general') {
      // General search using duck-duck-scrape
      const safeSearchMap: Record<string, SafeSearchType> = {
        'Off': SafeSearchType.OFF,
        'Moderate': SafeSearchType.MODERATE,
        'Strict': SafeSearchType.STRICT
      }

      const count = CONFIG.search.getResultsPerPage(searchDepth)
      const resultsPerPage = 30
      const pagesNeeded = Math.ceil(count / resultsPerPage)
      let allResults: { url: string; title: string; description: string }[] = []

      console.log(`Starting general search for "${query}" (${count} results requested)`)

      for (let page = 0; page < pagesNeeded; page++) {
        console.log(`Fetching page ${page + 1}/${pagesNeeded}...`)
        
        let retries = 3
        while (retries > 0) {
          try {
            // Add initial delay before first request
            if (page === 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const searchResults = await search(query, {
              safeSearch: safeSearchMap[CONFIG.search.safeSearch] || SafeSearchType.MODERATE,
              offset: page * resultsPerPage,
              // userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            })
            
            const uniqueNewResults = searchResults.results.filter(
              result => !allResults.some(existing => existing.url === result.url)
            )
            
            allResults = [...allResults, ...uniqueNewResults]
            console.log(`Page ${page + 1} returned ${searchResults.results.length} results (${uniqueNewResults.length} new)`)
            
            if (allResults.length >= count) break
            
            await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 4000)) // 3-7 second delay between pages
            break
          } catch (error) {
            retries--
            if (retries === 0) throw error
            const delay = (2 ** (5 - retries) * 2000) + Math.random() * 2000; // Exponential backoff with jitter (8s, 4s, 2s)
            console.log(`Retrying in ${delay}ms...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }

        if (allResults.length >= count) break
      }

      allResults = allResults
        .slice(0, count)
        .sort((a, b) => a.url.localeCompare(b.url))

      console.log(`Final results: ${allResults.length} unique items`)

      return NextResponse.json({
        webPages: {
          value: allResults.map(result => ({
            id: result.url,
            url: result.url,
            name: result.title,
            snippet: result.description
          }))
        }
      })
    } else {
      return NextResponse.json(
        { error: 'Invalid searchType' },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error('Search API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch search results' },
      { status: 500 }
    )
  }
}
