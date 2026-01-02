import { randomUUID } from 'node:crypto'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Recursively get all markdown files from a directory tree
function getAllMarkdownFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = []

  try {
    const entries = readdirSync(dir)

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        results.push(...getAllMarkdownFilesRecursive(fullPath, baseDir))
      } else if (entry.endsWith('.md')) {
        // Store relative path instead of absolute
        const relativePath = relative(baseDir, fullPath)

        // Filter out algorithm files with numbers > 100
        if (relativePath.includes('2_algorithms')) {
          const match = entry.match(/^(\d+)_/)
          if (match?.[1]) {
            const fileNumber = parseInt(match[1], 10)
            if (fileNumber > 100) {
              continue // Skip files with numbers > 100 in algorithms folder
            }
          }
        }

        results.push(relativePath)
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return results
}

// Main function to collect all learning files in the correct order
function collectLearningFiles(): string[] {
  const projectRoot = process.cwd()
  const baseDir = join(projectRoot, '1_learning')

  // Get all markdown files recursively and sort them
  // The numeric prefixes in directory and file names ensure correct ordering
  const files = getAllMarkdownFilesRecursive(baseDir, projectRoot)
  files.sort()

  return files
}

// Generate learnings.json
function generateLearningJson() {
  console.log('Collecting learning files...')
  const files = collectLearningFiles()

  console.log(`Found ${files.length} files`)

  // Generate the array with file paths and UUIDs
  const learning = files.map((file) => ({
    file,
    uid: randomUUID()
  }))

  // Write to learnings.json
  const outputPath = join(process.cwd(), 'learnings.json')
  writeFileSync(outputPath, JSON.stringify(learning, null, 2))

  console.log(`✓ Generated learnings.json with ${learning.length} entries`)
  console.log(`  Output: ${outputPath}`)
}

// Run the script
generateLearningJson()
