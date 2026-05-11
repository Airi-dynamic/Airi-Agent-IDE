import Editor from '@monaco-editor/react'
import { useEditorStore } from '../../stores/editor.store'
import { useMemo } from 'react'

const EMPTY_EDITOR_TEXT = `// Day 3
// 请从左侧文件树点击一个文件，内容会显示在这里。
`

function getLanguageByFilePath(filePath: string | null): string {
  if (!filePath) return 'typescript'
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

export default function MonacoWrapper() {
  const openFilePath = useEditorStore((state) => state.openFilePath)
  const openFileContent = useEditorStore((state) => state.openFileContent)
  const setOpenFileContent = useEditorStore((state) => state.setOpenFileContent)

  const editorLanguage = useMemo(() => getLanguageByFilePath(openFilePath), [openFilePath])
  const displayValue = openFilePath ? openFileContent : EMPTY_EDITOR_TEXT

  return (
    <Editor
      height="100%"
      path={openFilePath ?? 'day3-welcome.ts'}
      language={editorLanguage}
      value={displayValue}
      theme="vs-dark"
      onChange={(value) => {
        if (openFilePath) {
          setOpenFileContent(value ?? '')
        }
      }}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
      }}
    />
  )
}
