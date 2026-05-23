import Foundation
import ApplicationServices

let bundleID = "com.kindmd.app" as CFString

// UTIs to claim as default.
// - net.daringfireball.markdown / public.markdown: canonical Markdown UTIs
// - public.comma-separated-values-text: canonical CSV UTI
// - public.tab-separated-values-text: canonical TSV UTI
let utis: [String] = [
    "net.daringfireball.markdown",
    "public.markdown",
    "public.comma-separated-values-text",
    "public.tab-separated-values-text",
]

for uti in utis {
    let status = LSSetDefaultRoleHandlerForContentType(
        uti as CFString,
        .all,
        bundleID
    )
    if status == noErr {
        print("\(uti): OK")
    } else {
        print("\(uti): status=\(status)")
    }
}

// Also set per-extension via UTType lookup (covers any dyn.* synthetic UTIs).
import UniformTypeIdentifiers
for ext in ["md", "markdown", "mdown", "mkd", "csv", "tsv"] {
    if let t = UTType(filenameExtension: ext) {
        let status = LSSetDefaultRoleHandlerForContentType(
            t.identifier as CFString,
            .all,
            bundleID
        )
        print("\(ext) → \(t.identifier): \(status == noErr ? "OK" : "status=\(status)")")
    } else {
        print("\(ext): no UTType")
    }
}

print("Done.")
