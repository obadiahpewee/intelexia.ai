export interface Article {
  url: string
  title: string
  content: string
}

export interface Source {
  id: string
  url: string
  name: string
}

export type Report = {
  title: string
  summary: string
  sections: {
    title: string
    content: string
  }[]
  sources: {
    id: string
    url: string
    name: string
  }[]
}

export type KnowledgeBaseReport = {
  id: string
  timestamp: number
  query: string
  report: Report
}
