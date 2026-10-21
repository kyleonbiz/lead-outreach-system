import { ComingSoon } from './ComingSoon'
export default function DocumentsPage() {
  return (
    <ComingSoon
      title="Documents" phase="Phase 5"
      description="Upload, search, summarize and generate business documents."
      needs={['Supabase Storage bucket (created by migration 0002)', 'document processing functions']}
    />
  )
}
