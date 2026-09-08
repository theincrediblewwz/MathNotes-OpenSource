import Foundation

struct SessionFindBlock {
    let id: String
    let text: String
    let canReplace: Bool
}

struct SessionFindMatch: Equatable {
    let blockID: String
    let range: NSRange
    let canReplace: Bool
}

struct SourceFindSelection: Equatable {
    let id = UUID()
    let blockID: String
    let range: NSRange
}

enum SessionFindEngine {
    static func matches(in blocks: [SessionFindBlock], query: String, matchCase: Bool) -> [SessionFindMatch] {
        guard !query.isEmpty else { return [] }
        return blocks.flatMap { block -> [SessionFindMatch] in
            let text = block.text as NSString
            var result: [SessionFindMatch] = []
            var start = 0
            while start < text.length {
                let range = text.range(of: query, options: matchCase ? [] : [.caseInsensitive],
                    range: NSRange(location: start, length: text.length - start))
                guard range.location != NSNotFound, range.length > 0 else { break }
                result.append(SessionFindMatch(blockID: block.id, range: range, canReplace: block.canReplace))
                start = NSMaxRange(range)
            }
            return result
        }
    }

    static func replacing(_ text: String, ranges: [NSRange], with replacement: String) -> String {
        let result = NSMutableString(string: text)
        for range in ranges.sorted(by: { $0.location > $1.location }) {
            result.replaceCharacters(in: range, with: replacement)
        }
        return result as String
    }
}
