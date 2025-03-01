'use client'

import { useState, useEffect } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import {
  Search,
  FileText,
  Download,
  Plus,
  X,
  ChevronDown,
  Brain,
  Info,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Report } from '@/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CONFIG } from '@/lib/config'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useKnowledgeBase } from '@/lib/hooks/use-knowledge-base'
import { useToast } from '@/hooks/use-toast'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { KnowledgeBaseSidebar } from '@/components/knowledge-base-sidebar'
import { DarkModeToggle } from '@/components/ui/dark-mode-toggle'
import { Spinner } from '@/components/ui/spinner'

type SearchResult = {
  id: string
  url: string
  name: string
  snippet: string
  isCustomUrl?: boolean
  metadata?: {
    venue: string
    year: number
    authors: string
  }
}

type PlatformModel = {
  value: string
  label: string
  platform: string
  disabled: boolean
}

const platformModels = Object.entries(CONFIG.platforms)
  .flatMap(([platform, config]) => {
    if (!config.enabled) return []

    return Object.entries(config.models).map(([modelId, modelConfig]) => {
      return {
        value: `${platform}__${modelId}`,
        label: `${platform.charAt(0).toUpperCase() + platform.slice(1)} - ${
          modelConfig.label
        }`,
        platform,
        disabled: !modelConfig.enabled,
      }
    })
  })
  .filter(Boolean) as (PlatformModel & { disabled: boolean })[]

const MAX_SELECTIONS = CONFIG.search.maxSelectableResults

export default function Home() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedResults, setSelectedResults] = useState<string[]>([])
  const [reportPrompt, setReportPrompt] = useState('')
  const [generatingReport, setGeneratingReport] = useState(false)
  const [activeTab, setActiveTab] = useState('search')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState<{
    total: number
    successful: number
    fallback: number
    sourceStatuses: Record<string, 'fetched' | 'preview'>
  }>({ total: 0, successful: 0, fallback: 0, sourceStatuses: {} })
  const [newUrl, setNewUrl] = useState('')
  const [isSourcesOpen, setIsSourcesOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(
    'google__gemini-flash-thinking'
  )
  const { addReport } = useKnowledgeBase()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchMode, setSearchMode] = useState('auto')
  const [searchDepth, setSearchDepth] = useState('light')
  const [searchType, setSearchType] = useState('general')
  const [citationStyle, setCitationStyle] = useState('apa')
  const [wordCount, setWordCount] = useState('1500')
  const [slideCount, setSlideCount] = useState('10')
  const [documentType, setDocumentType] = useState('report')
  const [isExpanded, setIsExpanded] = useState(false)
  const [deepSearchBreadth, setDeepSearchBreadth] = useState(4)
  const [deepSearchDepth, setDeepSearchDepth] = useState(2)
  const [aiClarification, setAiClarification] = useState('allow')
  const [deepSearchProgress, setDeepSearchProgress] = useState<{
    currentDepth: number
    totalDepth: number
    currentBreadth: number
    totalBreadth: number
    currentQuery?: string
    totalQueries: number
    completedQueries: number
  }>({
    currentDepth: 0,
    totalDepth: 0,
    currentBreadth: 0,
    totalBreadth: 0,
    totalQueries: 0,
    completedQueries: 0
  })

  interface TabGroupOption {
    value: string;
    label: string;
  }

  const TabGroup = ({ 
    options,
    value,
    onChange
  }: {
    options: TabGroupOption[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <div className="bg-gray-100 dark:bg-[#3a3b3e] p-1 rounded-lg inline-flex gap-1 w-fit">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
            value === option.value
              ? 'bg-white dark:bg-[#444548] shadow-sm text-gray-800 dark:text-gray-100'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#4a4b4e]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

  useEffect(() => {
    if (searchMode === 'manual') {
      setSearchDepth('custom')
    } else {
      setSearchDepth('light')
    }
  }, [searchMode])

  useEffect(() => {
    if (documentType === 'presentation' && searchType === 'deep') {
      setSearchType('general')
    }
  }, [documentType])

  // Add an effect to automatically switch to auto mode when deep search is selected
  useEffect(() => {
    if (searchType === 'deep' && searchMode === 'manual') {
      setSearchMode('auto')
    }
  }, [searchType])

  const { toast } = useToast()

  // Declare timeoutId at the function level
  let timeoutId: NodeJS.Timeout;

  // Add abort controller for report generation
  const reportController = new AbortController();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setError(null)
    setReportPrompt('')
    setReport(null)

    try {
      // Store custom URLs only (we don't preserve selections on new search)
      const customUrls = results.filter((r) => r.isCustomUrl)

      // Clear existing search results while maintaining custom URLs only
      setResults([...customUrls])
      
      // Clear selected results when starting a new search
      if (searchMode === 'auto') {
        setSelectedResults([])
      }

      // Use deep search API if searchType is 'deep'
      const endpoint = searchType === 'deep' ? '/api/deep-search' : '/api/search'
      const searchParams = searchType === 'deep' 
        ? {
            query,
            searchDepth: deepSearchDepth,
            searchBreadth: deepSearchBreadth,
          }
        : {
            query,
            searchType,
            searchDepth,
          }

      // Add abort controller with 15-minute timeout
      const controller = new AbortController()
      timeoutId = setTimeout(() => controller.abort(), 900000) // 15 minutes

      console.log('Sending search request:', { endpoint, searchParams })
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(searchParams),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // Read the response body ONCE
      const data = await response.json()

      // Handle successful responses even with partial data
      if (response.status === 200) {
        console.log('Search API response:', data)
        // Show warning for partial failures but continue processing
        if (data.errors?.length > 0) {
          setError(`Partial results: ${data.errors[0]}`) // Show first error as example
          console.warn('Deep search completed with errors:', data.errors)
        }

        // Proceed with report generation if we have learnings
        if (data.learnings) {
          const learningsPrompt = data.learnings.join('\n\n')
          setReportPrompt(learningsPrompt)
          // ... rest of report generation code ...
        }

        // Create a Set to track unique URLs
        const seenUrls = new Set<string>()
        
        // Add URLs of custom URLs to seenUrls
        customUrls.forEach(item => seenUrls.add(item.url))

        // Process new search results
        const timestamp = Date.now()
        const newResults = (data.webPages?.value || [])
          .filter((result: SearchResult) => !seenUrls.has(result.url))
          .map((result: SearchResult) => ({
            ...result,
            id: result.id ? `${searchType}-${timestamp}-${result.id}` : `${searchType}-${timestamp}-${result.url}`,
          }))

        console.log('Processed search results:', newResults)
        
        // Combine custom URLs and new results
        const finalResults = [...customUrls, ...newResults]
        
        // Update the results state
        setResults(finalResults)

        // For deep search, also store learnings and generate report
        if (searchType === 'deep' && data.learnings) {
          console.log('Deep search learnings:', data.learnings)
          const learningsPrompt = data.learnings.join('\n\n')
          setReportPrompt(learningsPrompt)

          // Auto-select all results for deep search
          const newSelectedIds = newResults.map((r: SearchResult) => r.id)
          setSelectedResults(newSelectedIds)

          // Automatically generate report for deep search
          try {
            console.log('Generating deep report from learnings...')
            const reportResponse = await fetch('/api/deep-report', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                learnings: data.learnings,
                sources: data.webPages.value.map((r: SearchResult) => ({
                  id: r.id,
                  url: r.url,
                  name: r.name
                })),
                prompt: `Analyze and synthesize the following learnings into a comprehensive report:\n\n${data.learnings.join('\n\n')}`,
                platformModel: selectedModel,
                citationStyle: citationStyle === 'apa' ? 'APA 7th Edition' : 
                              citationStyle === 'mla' ? 'MLA 9th Edition' : 
                              'IEEE',
                contentType: documentType,
                slideCount: documentType === 'presentation' ? parseInt(slideCount) || 10 : undefined,
                wordCount: documentType === 'report' ? parseInt(wordCount) || 1500 : undefined,
                model: selectedModel.split('__')[1],
                searchParams: {
                  depth: deepSearchDepth,
                  breadth: deepSearchBreadth
                }
              }),
              signal: reportController.signal
            })

            if (!reportResponse.ok) {
              throw new Error(`Report generation failed: ${reportResponse.statusText}`)
            }

            const reportData = await reportResponse.json()
            console.log('Generated deep report:', reportData)
            setReport(reportData)
            setActiveTab('report')
          } catch (error) {
            console.error('Deep report generation failed:', error)
            setError(error instanceof Error ? error.message : 'Report generation failed')
          }
        }

        // Handle auto-selection mode with fresh selection for non-deep searches
        if (searchMode === 'auto' && searchType !== 'deep') {
          let count = searchDepth === 'medium' 
            ? 6 
            : searchDepth === 'heavy' 
              ? 10 
              : 3 // Default for light
          
          // Select from new results only, up to the count based on search depth
          const newSelectedIds = newResults
            .slice(0, count)
            .map((r: SearchResult) => r.id)
          
          // Set the new selections (don't preserve old ones)
          setSelectedResults(newSelectedIds)
        }
      }

      // Handle errors
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(
            'Rate limit exceeded. Please wait a moment before trying again.'
          )
        }
        throw new Error('Search failed. Please try again.')
      }
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setError('Deep search timed out after 15 minutes')
        } else if (!error.message.includes('Partial results')) {
          console.error('Search failed:', error)
          setError(error.message)
        }
      } else {
        console.error('Unexpected error:', error)
        setError('An unexpected error occurred')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleResultSelect = (resultId: string) => {
    setSelectedResults((prev) => {
      if (prev.includes(resultId)) {
        return prev.filter((id) => id !== resultId)
      }
      if (prev.length >= MAX_SELECTIONS) {
        return prev
      }
      return [...prev, resultId]
    })
  }

  const handleAddCustomUrl = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUrl.trim()) return

    try {
      new URL(newUrl) // Validate URL format
      if (!results.some((r) => r.url === newUrl)) {
        const timestamp = Date.now()
        const newResult: SearchResult = {
          id: `custom-${timestamp}-${newUrl}`,
          url: newUrl,
          name: 'Custom URL',
          snippet: 'Custom URL added by user',
          isCustomUrl: true,
        }
        setResults((prev) => [newResult, ...prev])
      }
      setNewUrl('')
    } catch {
      setError('Please enter a valid URL')
    }
  }

  const handleRemoveResult = (resultId: string) => {
    setResults((prev) => prev.filter((r) => r.id !== resultId))
    setSelectedResults((prev) => prev.filter((id) => id !== resultId))
  }

  const handleGenerateReport = async () => {
    if (!reportPrompt || selectedResults.length === 0) return

    setGeneratingReport(true)
    setError(null)
    setFetchStatus({
      total: selectedResults.length,
      successful: 0,
      fallback: 0,
      sourceStatuses: {},
    })

    try {
      const selectedArticles = results.filter((r) =>
        selectedResults.includes(r.id)
      )

      // Fetch content for each URL
      const contentResults = []
      let hitRateLimit = false

      for (const article of selectedArticles) {
        try {
          const response = await fetch('/api/fetch-content', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: article.url }),
          })

          if (response.ok) {
            const { content } = await response.json()
            contentResults.push({
              url: article.url,
              title: article.name,
              content: content,
            })
            setFetchStatus((prev) => ({
              ...prev,
              successful: prev.successful + 1,
              sourceStatuses: {
                ...prev.sourceStatuses,
                [article.url]: 'fetched',
              },
            }))
          } else if (response.status === 429) {
            hitRateLimit = true
            throw new Error(
              'Rate limit exceeded. Please wait a moment before generating another report.'
            )
          } else {
            console.warn(
              `Failed to fetch content for ${article.url}, using snippet`
            )
            contentResults.push({
              url: article.url,
              title: article.name,
              content: article.snippet,
            })
            setFetchStatus((prev) => ({
              ...prev,
              fallback: prev.fallback + 1,
              sourceStatuses: {
                ...prev.sourceStatuses,
                [article.url]: 'preview',
              },
            }))
          }
        } catch (error) {
          if (hitRateLimit) throw error
          console.warn(`Error fetching ${article.url}, using snippet:`, error)
          contentResults.push({
            url: article.url,
            title: article.name,
            content: article.snippet,
          })
          setFetchStatus((prev) => ({
            ...prev,
            fallback: prev.fallback + 1,
          }))
        }
      }

      // Only proceed with successful fetches
      const successfulResults = contentResults.filter(
        (result) => result.content && result.content.trim().length > 0
      )

      if (successfulResults.length === 0) {
        throw new Error(
          'Failed to fetch usable content for any of the selected articles'
        )
      }

      // Update the report generation API call
      const response = await fetch('/api/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
          body: JSON.stringify({
            selectedResults: successfulResults,
            sources: results
              .filter((r) => selectedResults.includes(r.id))
              .map((r) => ({
                id: r.id,
                url: r.url,
                name: r.name,
              })),
            prompt: `${reportPrompt}. Provide a comprehensive analysis that synthesizes all relevant information from the provided sources.`,
            platformModel: selectedModel,
            citationStyle: citationStyle === 'apa' ? 'APA 7th Edition' : 
                          citationStyle === 'mla' ? 'MLA 9th Edition' : 
                          'IEEE',
            contentType: documentType,
            slideCount: documentType === 'presentation' ? parseInt(slideCount) || 10 : undefined,
            wordCount: documentType === 'report' ? parseInt(wordCount) || 1500 : undefined,
            model: selectedModel.split('__')[1],
          }),
      })

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(
            'Rate limit exceeded. Please wait a moment before generating another report.'
          )
        }
        if (response.status === 503) {
          throw new Error(
            'Report generation failed; server busy. Please retry shortly.'
          )
        }
        throw new Error('Report failed; retry with different options/model')
        // throw new Error('Failed to generate report. Please try again.')
      }

      const data = await response.json()
      console.log('Report data:', data)
      setReport(data)
      setActiveTab('report')
    } catch (error) {
      console.error('Report generation failed:', error)
      setError(
        error instanceof Error ? error.message : 'Report generation failed'
      )
    } finally {
      setGeneratingReport(false)
    }
  }

  const handleDownload = async (format: 'pdf' | 'docx' | 'txt' | 'pptx') => {
    if (!report) return

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          report,
          format,
        }),
      })

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `report.${format}`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  const handleSaveToKnowledgeBase = () => {
    if (!report) return
    const success = addReport(report, reportPrompt)
    if (success) {
      toast({
        title: 'Saved to Knowledge Base',
        description: 'The report has been saved for future reference',
      })
    }
  }

  // Add progress bar component for deep search
  const DeepSearchProgress = () => {
    const progress = deepSearchProgress
    if (!loading || searchType !== 'deep') return null

    return (
      <div className="mb-4 p-4 bg-gray-50 dark:bg-[#333538] rounded-lg">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Depth Progress */}
          <div className="flex-1">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-300">Depth</span>
              <span className="text-gray-500 dark:text-gray-400">
                {progress.totalDepth - progress.currentDepth}/{progress.totalDepth}
              </span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-[#A8A9D6] transition-all duration-300"
                style={{ 
                  width: `${((progress.totalDepth - progress.currentDepth) / progress.totalDepth) * 100}%`,
                }}
              />
            </div>
          </div>

          {/* Breadth Progress */}
          <div className="flex-1">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-300">Breadth</span>
              <span className="text-gray-500 dark:text-gray-400">
                {progress.totalBreadth - progress.currentBreadth}/{progress.totalBreadth}
              </span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-[#A8A9D6] transition-all duration-300"
                style={{ 
                  width: `${((progress.totalBreadth - progress.currentBreadth) / progress.totalBreadth) * 100}%`,
                }}
              />
            </div>
          </div>

          {/* Queries Progress */}
          <div className="flex-1">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-300">Queries</span>
              <span className="text-gray-500 dark:text-gray-400">
                {progress.completedQueries}/{progress.totalQueries}
              </span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-[#A8A9D6] transition-all duration-300"
                style={{ 
                  width: `${(progress.completedQueries / progress.totalQueries) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>

        {/* Add spinner container below progress bars */}
        <div className="flex justify-center mt-4">
          <Spinner className="h-8 w-8 text-[#A8A9D6] animate-spin" />
        </div>

        {progress.currentQuery && (
          <div className="text-sm text-gray-600 dark:text-gray-400 mt-2 text-center">
            Current Query: {progress.currentQuery}
          </div>
        )}
      </div>
    )
  }

  // Add cleanup in useEffect
  useEffect(() => {
    return () => {
      if (reportController) {
        reportController.abort()
      }
    }
  }, [])

  return (
    <div className='min-h-screen bg-white dark:bg-[#292a2d] p-4 sm:p-8 relative'>
      <KnowledgeBaseSidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
      <main className='max-w-4xl mx-auto'>
        {error && (
          <div className='mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 text-center'>
            {error}
          </div>
        )}

        <div className='flex justify-between items-center mb-8'>
          <div>
            <button
              onClick={() => setSidebarOpen(true)}
              className='text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-300 inline-flex items-center gap-2 text-sm border rounded-lg px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors'
            >
              <Brain className='h-4 w-4' />
              View Knowledge Base
            </button>
          </div>
          <div>
            <DarkModeToggle />
          </div>
        </div>

        <div className='mb-3'>
          <h1 className='mb-2 text-center text-gray-800 flex items-center justify-center gap-2'>
            <img
              src='/apple-icon.png'
              alt='Open Deep Research'
              className='w-[486px] h-[112px]'
            />          
          </h1>
          <div className='text-center space-y-3 mb-8'>
            <p className='text-gray-600 dark:text-gray-400'>
              A free AI Deep Research tool to generate reports and presentations automatically or by manually selecting sources.
            </p>
          </div>
          <form onSubmit={handleSearch} className='space-y-4'>
            <div className='flex flex-col sm:flex-row gap-2'>
              <div className='relative flex-1'>
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='Enter your research query...'
                  className='flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm pr-8 resize-none overflow-y-auto'
                  style={{ 
                    lineHeight: '1.5',
                    height: '40px',
                    minHeight: '40px',
                    maxHeight: '96px'
                  }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = '40px';
                    const newHeight = Math.min(target.scrollHeight, 96);
                    target.style.height = `${newHeight}px`;
                  }}
                />
                <Search className='absolute right-2 top-2 h-5 w-5 text-gray-400 pointer-events-none' />
              </div>

              <div className='flex gap-2'>
                <Button
                  type='submit'
                  disabled={loading}
                  className='shrink-0 flex-1 sm:flex-initial'
                >
                  {loading ? 'Searching...' : 'Search'}
                </Button>
              </div>
            </div>
          </form>
        </div>

        <div className="mt-6 mb-6 p-4 bg-gray-50 dark:bg-[#333538] rounded-lg">
          <div className="flex gap-4 mb-4">
            {/* Search Mode Section */}
            <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '230px', minWidth: '230px' }}>
              <span className="text-sm text-gray-600 dark:text-gray-300">Source Selection:</span>
              <div className="bg-gray-100 dark:bg-[#3a3b3e] p-1 rounded-lg inline-flex gap-1 w-fit">
                {[
                  { value: 'auto', label: 'Auto (AI decides)' },
                  { value: 'manual', label: 'Manual' }
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      // Only allow changing to manual if not in deep search
                      if (!(option.value === 'manual' && searchType === 'deep')) {
                        setSearchMode(option.value)
                      }
                    }}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
                      searchMode === option.value
                        ? 'bg-white dark:bg-[#444548] shadow-sm text-gray-800 dark:text-gray-100'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#4a4b4e]'
                    } ${
                      option.value === 'manual' && searchType === 'deep'
                        ? 'cursor-not-allowed opacity-50'
                        : ''
                    }`}
                    disabled={option.value === 'manual' && searchType === 'deep'}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Search Depth Section */}
            <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '360px', minWidth: '360px' }}>
              <span className="text-sm text-gray-600 dark:text-gray-300">Search Depth</span>
              <div className="bg-gray-100 dark:bg-[#3a3b3e] p-1 rounded-lg flex gap-1">
              {[
                { value: 'light', label: 'Light (3)' },
                { value: 'medium', label: 'Medium (6)' },
                { value: 'heavy', label: 'Heavy (10)' },
                { value: 'custom', label: 'Custom' }
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    if ((searchMode === 'auto' && option.value !== 'custom') || 
                        (searchMode === 'manual' && option.value === 'custom')) {
                      setSearchDepth(option.value)
                    }
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
                    searchDepth === option.value
                      ? 'bg-white dark:bg-[#444548] shadow-sm text-gray-800 dark:text-gray-100'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#4a4b4e]'
                  } ${
                    (searchMode === 'manual' && option.value !== 'custom') ||
                    (searchMode === 'auto' && option.value === 'custom')
                      ? 'cursor-not-allowed opacity-50'
                      : ''
                  }`}
                  disabled={
                    (searchMode === 'manual' && option.value !== 'custom') ||
                    (searchMode === 'auto' && option.value === 'custom')
                  }
                >
                  {option.label}
                </button>
              ))}
              </div>
            </div>

            {/* Search Type Section */}
            <div className="flex flex-col gap-2 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-600 dark:text-gray-300">Search Type</span>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] bg-black text-white text-xs p-2 border-none">
                    <p>General: Standard search (fast)</p>
                    <p>Academic: Peer-reviewed journals via Semantic-Scholar (Servers might be busy, search may require multiple attempts)</p>
                    <p>Deep: Recursively refined search (slow, precise), code interpreter coming soon!</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="bg-gray-100 dark:bg-[#3a3b3e] p-1 rounded-lg flex gap-1">
                {[
                  { value: 'general', label: 'General' },
                  { value: 'academic', label: 'Academic' },
                  { value: 'deep', label: 'Deep' }
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      if (!(option.value === 'deep' && documentType === 'presentation')) {
                        setSearchType(option.value)
                      }
                    }}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
                      searchType === option.value
                        ? 'bg-white dark:bg-[#444548] shadow-sm text-gray-800 dark:text-gray-100'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#4a4b4e]'
                    } ${
                      option.value === 'deep' && documentType === 'presentation'
                        ? 'cursor-not-allowed opacity-50'
                        : ''
                    }`}
                    disabled={option.value === 'deep' && documentType === 'presentation'}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!isExpanded && (
            <div className="flex justify-center mb-4">
              <button 
                onClick={() => setIsExpanded(true)}
                className="flex items-center gap-1 text-gray-600 dark:text-gray-300 text-sm hover:text-gray-800 dark:hover:text-gray-200"
              >
                <ChevronDown className="w-4 h-4" />
                More options
              </button>
            </div>
          )}

          {isExpanded && (
            <>
              <div className="flex gap-4 mb-4">
                {/* Generated Output Section */}
                <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '230px', minWidth: '230px' }}>
                  <span className="text-sm text-gray-600 dark:text-gray-300">Generated Output</span>
                  <TabGroup
                    options={[
                      { value: 'report', label: 'Report' },
                      { value: 'presentation', label: 'Presentation' }
                    ]}
                    value={documentType}
                    onChange={setDocumentType}
                  />
                </div>

                {/* Word Limit/Slide Count Section */}
                <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '360px', minWidth: '360px' }}>
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    {documentType === 'report' ? 'Word Count' : 'Slide Count'}
                  </span>
                  {documentType === 'report' ? (
                    <TabGroup
                      options={[
                        { value: 'n/a', label: 'N/A' },
                        { value: '750', label: '750' },
                        { value: '1500', label: '1500' },
                        { value: '3000', label: '3000' }
                      ]}
                      value={wordCount}
                      onChange={setWordCount}
                    />
                  ) : (
                    <TabGroup
                      options={[
                        { value: 'n/a', label: 'N/A' },
                        { value: '5', label: '5' },
                        { value: '10', label: '10' },
                        { value: '25', label: '25' }
                      ]}
                      value={slideCount}
                      onChange={setSlideCount}
                    />
                  )}
                </div>

                {/* Citation Style Section */}
                <div className="flex flex-col gap-2 flex-1">
                  <span className="text-sm text-gray-600 dark:text-gray-300">Citation Style</span>
                  <TabGroup
                    options={[
                      { value: 'apa', label: 'APA-7' },
                      { value: 'ieee', label: 'IEEE' },
                      { value: 'mla', label: 'MLA-9' }
                    ]}
                    value={citationStyle}
                    onChange={setCitationStyle}
                  />
                </div>
              </div>

              {/* Deep Search Parameters Section */}
              {searchType === 'deep' && documentType === 'report' && (
                <div className="flex gap-4 mb-4">
                  {/* Deep Search Breadth Slider */}
                  <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '230px', minWidth: '230px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600 dark:text-gray-300">Deep-search-breadth</span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">{deepSearchBreadth}</span>
                    </div>
                    <Slider
                      value={[deepSearchBreadth]}
                      onValueChange={(value) => setDeepSearchBreadth(value[0])}
                      min={2}
                      max={10}
                      step={1}
                      className="py-2"
                    />
                  </div>

                  {/* Deep Search Depth Slider */}
                  <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: '360px', minWidth: '360px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600 dark:text-gray-300">Deep-search-depth</span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">{deepSearchDepth}</span>
                    </div>
                    <Slider
                      value={[deepSearchDepth]}
                      onValueChange={(value) => setDeepSearchDepth(value[0])}
                      min={1}
                      max={5}
                      step={1}
                      className="py-2"
                    />
                  </div>

                  {/* AI Clarification Toggle */}
                  <div className="flex flex-col gap-2 flex-1">
                    <span className="text-sm text-gray-600 dark:text-gray-300">AI seeks clarification?</span>
                    <TabGroup
                      options={[
                        { value: 'allow', label: 'Allow' },
                        { value: 'disallow', label: 'Disallow' }
                      ]}
                      value={aiClarification}
                      onChange={setAiClarification}
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-center">
                <button 
                  onClick={() => setIsExpanded(false)}
                  className="flex items-center gap-1 text-gray-600 dark:text-gray-300 text-sm hover:text-gray-800 dark:hover:text-gray-200"
                >
                  <ChevronDown className="w-4 h-4 rotate-180" />
                  Less options
                </button>
              </div>
            </>
          )}
        </div>

        <DeepSearchProgress />

        {searchMode === 'manual' && (
          <div className='mb-6'>
            <form onSubmit={handleAddCustomUrl} className='flex gap-2 mb-2'>
              <Input
                type='url'
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder='Add custom URL...'
                className='flex-1'
              />
              <Button type='submit' variant='outline' size='icon'>
                <Plus className='h-4 w-4' />
              </Button>
            </form>
          </div>
        )}

        {(results.length > 0 || report) && (
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className='w-full'
          >
            <div className='mb-6 space-y-4'>
              <div className='flex flex-col sm:flex-row gap-2'>
                <div className='relative flex-1'>
                  <Input
                    type='text'
                    value={reportPrompt}
                    onChange={(e) => setReportPrompt(e.target.value)}
                    placeholder="What would you like to know? (e.g., 'Compare different approaches', 'Summarize key findings', 'Analyze trends')"
                    className='pr-8'
                    disabled={selectedResults.length === 0}
                  />
                  <FileText className='absolute right-2 top-2.5 h-5 w-5 text-gray-400' />
                </div>
                <div className='flex flex-col sm:flex-row gap-2'>
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                    disabled={platformModels.length === 0}
                  >
                    <SelectTrigger className='w-full sm:w-[200px]'>
                      <SelectValue
                        placeholder={
                          platformModels.length === 0
                            ? 'No models available'
                            : 'Select model'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {platformModels.map((model) => (
                        <SelectItem
                          key={model.value}
                          value={model.value}
                          disabled={model.disabled}
                          className={
                            model.disabled
                              ? 'text-gray-400 cursor-not-allowed'
                              : ''
                          }
                        >
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleGenerateReport}
                    disabled={
                      (selectedResults.length === 0 && results.length === 0) ||
                      !reportPrompt ||
                      generatingReport ||
                      platformModels.length === 0
                    }
                    variant='secondary'
                    className='w-full sm:w-auto bg-[#A8A9D6] hover:bg-[#A8A9D6]/90 text-white disabled:bg-[#A8A9D6]/50'
                  >
                    {generatingReport ? 'Generating...' : 'Generate Report'}
                  </Button>
                </div>
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 text-center sm:text-left space-y-1 relative flex items-center justify-between">
                <div className="space-y-1">
                  <p>
                    {selectedResults.length === 0
                      ? 'Select up to 10 results to generate a report'
                      : `${selectedResults.length} of ${MAX_SELECTIONS} results selected`}
                  </p>
                  {generatingReport && (
                    <p>
                      {fetchStatus.successful} fetched, {fetchStatus.fallback}{' '}
                      failed (of {fetchStatus.total})
                    </p>
                  )}
                </div>
                {generatingReport && (
                  <div className="ml-4 flex-shrink-0">
                    <Spinner className="h-5 w-5 text-[#A8A9D6] animate-spin" />
                  </div>
                )}
              </div>
            </div>

            <TabsList className='grid w-full grid-cols-2 mb-4 bg-gray-50 dark:bg-[#333538] p-1 rounded-lg'>
              <TabsTrigger 
                value='search'
                className='data-[state=active]:bg-white data-[state=active]:text-gray-800 dark:data-[state=active]:bg-[#444548] dark:data-[state=active]:text-gray-100 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#3a3b3e]'
              >
                Search Results
              </TabsTrigger>
              <TabsTrigger 
                value='report' 
                disabled={!report}
                className='data-[state=active]:bg-white data-[state=active]:text-gray-800 dark:data-[state=active]:bg-[#444548] dark:data-[state=active]:text-gray-100 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#3a3b3e]'
              >
                Report
              </TabsTrigger>
            </TabsList>

            <TabsContent value='search' className='space-y-4'>
              {results
                .filter((r) => r.isCustomUrl)
                .map((result) => (
                  <Card
                    key={result.id}
                    className='overflow-hidden border-2 border-[#A8A9D6]/20'
                  >
                    <CardContent className='p-4 flex gap-4'>
                      <div className='pt-1'>
                        <Checkbox
                          checked={selectedResults.includes(result.id)}
                          onCheckedChange={() => handleResultSelect(result.id)}
                          disabled={
                            !selectedResults.includes(result.id) &&
                            selectedResults.length >= MAX_SELECTIONS
                          }
                        />
                      </div>
                      <div className='flex-1 min-w-0'>
                        <div className='flex justify-between items-start'>
                          <a
                            href={result.url}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='text-[#A8A9D6] hover:underline'
                          >
                            <h2 className='text-xl font-semibold truncate'>
                              {result.name}
                            </h2>
                          </a>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => handleRemoveResult(result.id)}
                            className='ml-2'
                          >
                            <X className='h-4 w-4' />
                          </Button>
                        </div>
                        <p className='text-green-700 text-sm truncate'>
                          {result.url}
                        </p>
                        <p className='mt-1 text-gray-600 dark:text-gray-400 line-clamp-2'>
                          {result.snippet}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}

              {results
                .filter((r) => !r.isCustomUrl)
                .map((result) => (
                  <Card key={result.id} className='overflow-hidden'>
                    <CardContent className='p-4 flex gap-4'>
                      <div className='pt-1'>
                        <Checkbox
                          checked={selectedResults.includes(result.id)}
                          onCheckedChange={() => handleResultSelect(result.id)}
                          disabled={
                            !selectedResults.includes(result.id) &&
                            selectedResults.length >= MAX_SELECTIONS
                          }
                        />
                      </div>
                      <div className='flex-1 min-w-0'>
                        <h2 className='text-xl font-semibold truncate'>
                          <a
                            href={result.url}
                            target='_blank'
                            rel='noopener noreferrer'
                            className="hover:underline"
                            dangerouslySetInnerHTML={{ __html: result.name }}
                          />
                        </h2>
                        <p className='text-green-700 text-sm truncate'>
                          {result.url}
                        </p>
                        {result.metadata && (
                          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                            {result.metadata.authors && (
                              <p className="line-clamp-1">
                                <span className="font-medium">Authors:</span> {result.metadata.authors}
                              </p>
                            )}
                            <p>
                              {result.metadata.venue && (
                                <span className="mr-3">
                                  <span className="font-medium">Venue:</span> {result.metadata.venue}
                                </span>
                              )}
                              {result.metadata.year && (
                                <span>
                                  <span className="font-medium">Year:</span> {result.metadata.year}
                                </span>
                              )}
                            </p>
                          </div>
                        )}
                        <p
                          className='mt-1 text-gray-600 dark:text-gray-400 line-clamp-2'
                          dangerouslySetInnerHTML={{ __html: result.snippet }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </TabsContent>

            <TabsContent value='report'>
              {report && (
                <Card>
                  <CardContent className='p-6 space-y-6'>
                    <Collapsible
                      open={isSourcesOpen}
                      onOpenChange={setIsSourcesOpen}
                      className='w-full border rounded-lg p-2'
                    >
                      <CollapsibleTrigger className='flex items-center justify-between w-full'>
                        <span className='text-sm font-medium'>Overview</span>
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${
                            isSourcesOpen ? 'transform rotate-180' : ''
                          }`}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className='space-y-4 mt-2'>
                        <div className='text-sm text-gray-600 bg-gray-50 p-3 rounded'>
                          <p className='font-medium text-gray-700'>
                            {fetchStatus.successful} of {report.sources.length}{' '}
                            sources fetched successfully
                          </p>
                        </div>
                        <div className='space-y-2'>
                          {report.sources.map((source) => (
                            <div key={source.id} className='text-gray-600'>
                              <div className='flex items-center gap-2'>
                                <a
                                  href={source.url}
                                  target='_blank'
                                  rel='noopener noreferrer'
                                  className='text-[#A8A9D6] hover:underline'
                                >
                                  {source.name}
                                </a>
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${
                                    fetchStatus.sourceStatuses[source.url] ===
                                    'fetched'
                                      ? 'bg-green-100 text-green-700'
                                      : 'bg-yellow-50 text-yellow-600'
                                  }`}
                                >
                                  {fetchStatus.sourceStatuses[source.url] ===
                                  'fetched'
                                    ? 'fetched'
                                    : 'preview'}
                                </span>
                              </div>
                              <p className='text-sm text-gray-500'>
                                {source.url}
                              </p>
                            </div>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                    <div className='flex flex-col-reverse sm:flex-row sm:justify-between sm:items-start gap-4'>
                      
                      <div className='flex w-full sm:w-auto gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          className='gap-2'
                          onClick={handleSaveToKnowledgeBase}
                        >
                          <Brain className='h-4 w-4' />
                          Save to Knowledge Base
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant='outline'
                              size='sm'
                              className='gap-2'
                            >
                              <Download className='h-4 w-4' />
                              Download
                              <ChevronDown className='h-4 w-4'/>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end'>
                            <DropdownMenuItem
                              onClick={() => handleDownload('pdf')}
                            >
                              Download as PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDownload('docx')}
                            >
                              Download as Word
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDownload('pptx')}
                              disabled={documentType !== 'presentation'}
                            >
                              Download as PowerPoint
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDownload('txt')}
                            >
                              Download as Text
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>  
                    </div>
                    <div>
                      <h2 className='text-3xl font-bold text-foreground mb-2'>
                        {report.title}
                      </h2>
                    </div>
                    <p className='prose max-w-none dark:prose-invert prose-slate dark:prose-slate'>{report.summary}</p>
                    {report.sections.map((section, index) => (
                      <div key={index} className='space-y-2 border-t pt-4'>
                        <h3 className='text-3xl font-bold text-foreground mb-2'>
                          {section.title}
                        </h3>
                        <div className="prose max-w-none dark:prose-invert prose-slate dark:prose-slate">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {section.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  )
}
