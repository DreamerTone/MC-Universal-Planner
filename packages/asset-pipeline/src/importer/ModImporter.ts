import fs from "fs"
import path from "path"
import AdmZip from "adm-zip"

export class ModImporter {
    async importJar(jarPath: string) {
        const zip = new AdmZip(jarPath)

        const outputDir = path.join(
            process.cwd(),
            "cache/imported",
            path.basename(jarPath)
        )

        fs.mkdirSync(outputDir, { recursive: true })

        zip.extractAllTo(outputDir, true)

        return outputDir
    }
}