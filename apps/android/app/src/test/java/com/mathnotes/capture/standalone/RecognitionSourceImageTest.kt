package com.mathnotes.capture.standalone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class RecognitionSourceImageTest {
    private val link = "source-images/task-1/asset-1"

    @Test fun replacesOnlyStandaloneProseMarkersAndKeepsExplanation() {
        assertEquals("图中圆与切线相交。\n![识别照片（已处理）]($link)\n\n结论。", resolveRecognitionSourceImage("图中圆与切线相交。\n$SOURCE_IMAGE_MARKER\n\n结论。", link))
        assertEquals("文字 $SOURCE_IMAGE_MARKER 后文", resolveRecognitionSourceImage("文字 $SOURCE_IMAGE_MARKER 后文", link))
    }

    @Test fun fencesAndInlineCodeRemainLiteral() {
        for (markdown in listOf("```\n$SOURCE_IMAGE_MARKER\n```", "~~~~kotlin\n$SOURCE_IMAGE_MARKER\n~~~~", "`$SOURCE_IMAGE_MARKER`", "    $SOURCE_IMAGE_MARKER", "多行 `代码\n$SOURCE_IMAGE_MARKER\n结束` 后文")) {
            assertEquals(markdown, resolveRecognitionSourceImage(markdown, link))
        }
    }

    @Test fun markerAfterClosedCodeFenceStillResolves() {
        val markdown = "````md\n```\n$SOURCE_IMAGE_MARKER\n````\n\n$SOURCE_IMAGE_MARKER"
        assertEquals("````md\n```\n$SOURCE_IMAGE_MARKER\n````\n\n![识别照片（已处理）]($link)", resolveRecognitionSourceImage(markdown, link))
    }

    @Test fun noTrustedPhotoKeepsExplanationWithoutGuessingAnotherAsset() {
        assertEquals("图形说明\n_识别照片不可用_", resolveRecognitionSourceImage("图形说明\n$SOURCE_IMAGE_MARKER", null))
    }

    @Test fun legacyPlaceholderIsNotAutomaticallyBackfilled() {
        assertEquals("[图片：圆与切线]", resolveRecognitionSourceImage("[图片：圆与切线]", link))
    }

    @Test fun preservesLineEndingsAndRejectsUnsafeIds() {
        assertEquals("说明\r\n![识别照片（已处理）]($link)\r\n", resolveRecognitionSourceImage("说明\r\n $SOURCE_IMAGE_MARKER  \r\n", link))
        assertEquals(link, recognitionSourceImageLink("task-1", "asset-1"))
        assertNull(recognitionSourceImageLink("../secret", "asset"))
        assertNull(recognitionSourceImageLink("task", "asset?query"))
    }

    @Test fun promptRequestsMarkerWithoutInventingPathsAndViewerAllowsUserZoom() {
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains(SOURCE_IMAGE_MARKER))
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("没有图形时不要添加标记"))
        assertFalse(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("[图片：...]"))
        val html = standaloneSourceImageViewerHtml(link)
        assertTrue(html.contains("maximum-scale=8,user-scalable=yes"))
        assertTrue(html.contains("src=\"$link\""))
        assertFalse(html.contains("file://"))
    }

    @Test fun escapedTicksDoNotStartCodeAndPortableImagesSkipLiteralCode() {
        assertEquals("转义\\`\n![识别照片（已处理）]($link)\n转义\\`", resolveRecognitionSourceImage("转义\\`\n$SOURCE_IMAGE_MARKER\n转义\\`", link))
        val file = File.createTempFile("processed-image", ".png").canonicalFile
        try {
            file.writeBytes(byteArrayOf(1, 2, 3, 4))
            val picture = "![识别照片（已处理）]($link)"
            val output = ByteArrayOutputStream()
            writeStandalonePortableMarkdown(output, "说明\n$picture\n```\n$picture\n```\n`$picture`\n![识别照片（已处理）](source-images/other/asset)", mapOf(link to file))
            assertEquals("说明\n![识别照片（已处理）](data:image/png;base64,AQIDBA==)\n```\n$picture\n```\n`$picture`\n_识别照片不可用_", output.toString("UTF-8"))
        } finally { file.delete() }
    }
}
