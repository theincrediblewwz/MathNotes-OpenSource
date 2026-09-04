import Foundation

struct MacNormalizedPoint: Codable, Equatable, Sendable {
    let x: Double
    let y: Double

    init(x: Double, y: Double) {
        self.x = min(1, max(0, x))
        self.y = min(1, max(0, y))
    }
}

struct MacNormalizedRect: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(x: Double, y: Double, width: Double, height: Double) {
        let left = min(1, max(0, x))
        let top = min(1, max(0, y))
        self.x = left
        self.y = top
        self.width = min(1 - left, max(0, width))
        self.height = min(1 - top, max(0, height))
    }

    static func bounding(_ points: [MacNormalizedPoint]) -> MacNormalizedRect {
        guard let first = points.first else { return MacNormalizedRect(x: 0, y: 0, width: 0, height: 0) }
        let bounds = points.dropFirst().reduce(
            (minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
        ) { current, point in
            (
                min(current.minX, point.x),
                min(current.minY, point.y),
                max(current.maxX, point.x),
                max(current.maxY, point.y)
            )
        }
        return MacNormalizedRect(
            x: bounds.minX,
            y: bounds.minY,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY
        )
    }
}

enum MacImageTransformOperation: Encodable, Equatable, Sendable {
    case rotate(quarterTurns: Int)
    case perspective(corners: [MacNormalizedPoint])
    case crop(rect: MacNormalizedRect)
    case lasso(points: [MacNormalizedPoint], boundingBox: MacNormalizedRect)

    private enum CodingKeys: String, CodingKey {
        case type
        case quarterTurns
        case corners
        case rect
        case points
        case boundingBox
        case outsideFill
    }

    var contractOrder: Int {
        return switch self {
        case .rotate: 0
        case .perspective: 1
        case .crop: 2
        case .lasso: 3
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .rotate(quarterTurns):
            try container.encode("rotate", forKey: .type)
            try container.encode(quarterTurns, forKey: .quarterTurns)
        case let .perspective(corners):
            try container.encode("perspective", forKey: .type)
            try container.encode(corners, forKey: .corners)
        case let .crop(rect):
            try container.encode("crop", forKey: .type)
            try container.encode(rect, forKey: .rect)
        case let .lasso(points, boundingBox):
            try container.encode("lasso", forKey: .type)
            try container.encode(points, forKey: .points)
            try container.encode(boundingBox, forKey: .boundingBox)
            try container.encode("#ffffff", forKey: .outsideFill)
        }
    }
}

enum MacImageAnnotationObject: Encodable, Equatable, Identifiable, Sendable {
    case pen(id: String, points: [MacNormalizedPoint], color: String, width: Double)
    case arrow(
        id: String,
        start: MacNormalizedPoint,
        end: MacNormalizedPoint,
        color: String,
        width: Double
    )

    var id: String {
        return switch self {
        case let .pen(id, _, _, _), let .arrow(id, _, _, _, _): id
        }
    }

    var color: String {
        return switch self {
        case let .pen(_, _, color, _), let .arrow(_, _, _, color, _): color
        }
    }

    var width: Double {
        return switch self {
        case let .pen(_, _, _, width), let .arrow(_, _, _, _, width): width
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case points
        case start
        case end
        case color
        case width
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(color, forKey: .color)
        try container.encode(width, forKey: .width)
        switch self {
        case let .pen(_, points, _, _):
            try container.encode("pen", forKey: .type)
            try container.encode(points, forKey: .points)
        case let .arrow(_, start, end, _, _):
            try container.encode("arrow", forKey: .type)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
        }
    }
}

struct MacImageEditMetadata: Encodable, Equatable, Sendable {
    let operations: [MacImageTransformOperation]
    let annotations: [MacImageAnnotationObject]

    init(operations: [MacImageTransformOperation], annotations: [MacImageAnnotationObject]) {
        self.operations = operations.enumerated()
            .sorted { left, right in
                left.element.contractOrder == right.element.contractOrder
                    ? left.offset < right.offset
                    : left.element.contractOrder < right.element.contractOrder
            }
            .map(\.element)
        self.annotations = annotations
    }
}
