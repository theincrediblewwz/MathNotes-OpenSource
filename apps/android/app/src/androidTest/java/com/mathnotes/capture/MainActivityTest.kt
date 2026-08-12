package com.mathnotes.capture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun bottomNavigationOpensQueueAndSettings() {
        composeRule.onNodeWithText("拍下这一页").assertIsDisplayed()

        composeRule.onNodeWithText("笔记").performClick()
        composeRule.onNodeWithText("我的笔记").assertIsDisplayed()

        composeRule.onNodeWithText("队列").performClick()
        composeRule.onNodeWithText("上传与历史").assertIsDisplayed()

        composeRule.onNodeWithText("设置").performClick()
        composeRule.onNodeWithText("连接电脑").assertIsDisplayed()
        composeRule.onNodeWithText("扫描新电脑").assertIsDisplayed()
        composeRule.onNodeWithText("上传通知").assertIsDisplayed()
    }

    @Test
    fun pairedCaptureUsesOneSystemCameraEntryWithOptionalEditing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        PairingStore(instrumentation.targetContext).save(
            PairingConfig(
                1,
                "192.168.137.1",
                43424,
                "0123456789abcdef",
                "functional_analysis",
                "lecture",
                "private_http"
            )
        )
        instrumentation.uiAutomation.executeShellCommand(
            "pm grant com.mathnotes.capture android.permission.CAMERA"
        ).close()
        composeRule.activityRule.scenario.recreate()

        composeRule.onNodeWithText("从相册选择").assertIsEnabled()
        composeRule.onNodeWithText("选择 PDF").assertIsEnabled()
        composeRule.onNodeWithText("连续拍摄（MathNotes）").assertDoesNotExist()
        composeRule.onNodeWithText("高质量单张").assertDoesNotExist()
        composeRule.onNodeWithText("连续采集").assertDoesNotExist()
        composeRule.onAllNodesWithText("拍照").assertCountEquals(2)
        composeRule.onNodeWithText("拍后编辑").assertIsDisplayed()

        PairingStore(instrumentation.targetContext).clear()
    }

    @Test
    fun editAfterCaptureSelectionSurvivesActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        PairingStore(instrumentation.targetContext).save(
            PairingConfig(
                1,
                "192.168.137.1",
                43424,
                "0123456789abcdef",
                "functional_analysis",
                "lecture",
                "private_http"
            )
        )
        instrumentation.uiAutomation.executeShellCommand(
            "pm grant com.mathnotes.capture android.permission.CAMERA"
        ).close()
        composeRule.activityRule.scenario.recreate()

        composeRule.onNodeWithText("拍后编辑").performClick()
        composeRule.activityRule.scenario.recreate()
        composeRule.onNodeWithText("拍下这一页").assertIsDisplayed()
        composeRule.onAllNodesWithText("拍照").assertCountEquals(2)
        composeRule.onNodeWithText("拍后编辑").assertIsDisplayed()

        PairingStore(instrumentation.targetContext).clear()
    }

}
