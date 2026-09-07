package com.mathnotes.capture.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class NotebookTitleTest {
    @Test fun usesComputerNameInsteadOfDirectoryId() {
        assertEquals("广义函数讨论班", resolveNotebookTitle("20260907_a31b", "广义函数讨论班"))
    }

    @Test fun keepsCachedChineseNameWhenOlderEndpointOnlyReturnsAnId() {
        assertEquals("论文阅读", resolveNotebookTitle("20260907_a31b", "20260907_a31b", "论文阅读"))
    }

    @Test fun acceptsRenameAndNeverInventsATitleFromAnOpaqueId() {
        assertEquals("新标题", resolveNotebookTitle("id", "新标题", "旧标题"))
        assertEquals("未命名笔记本", resolveNotebookTitle("20260907_a31b", ""))
    }
}
