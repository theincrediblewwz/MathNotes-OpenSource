package com.mathnotes.capture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
        composeRule.onNodeWithText("我的笔记").assertIsDisplayed()

        composeRule.onNodeWithText("队列").performClick()
        composeRule.onNodeWithText("今日采集").assertIsDisplayed()

        composeRule.onNodeWithText("设置").performClick()
        composeRule.onNodeWithContentDescription("WWZ SYSU 头像").assertIsDisplayed()
        composeRule.onNodeWithText("WWZ SYSU").assertIsDisplayed()
        composeRule.onNodeWithText("github.com/theincrediblewwz").assertIsDisplayed()
        composeRule.onNodeWithText("连接电脑").assertIsDisplayed()
        composeRule.onNodeWithText("扫描新电脑").assertIsDisplayed()
        composeRule.onNodeWithText("上传通知").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun pairedCaptureOffersIntegratedAndSystemCameraWithOptionalEditing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        PairingStore(instrumentation.targetContext).save(
            PairingConfig(
                1,
                "127.0.0.1",
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

        composeRule.onNodeWithText("拍摄").performClick()
        composeRule.onNodeWithContentDescription("导入图片或 PDF").performClick()
        composeRule.onNodeWithText("打开手机原相机 · 拍完后导入").assertIsEnabled()
        composeRule.onNodeWithText("系统相机快捷拍摄 · 自动返回").assertIsEnabled()
        composeRule.onNodeWithText("从相册选择").assertIsEnabled()
        composeRule.onNodeWithText("导入 PDF").assertIsNotEnabled()
        composeRule.onNodeWithText("连续拍摄（MathNotes）").assertDoesNotExist()
        composeRule.onNodeWithText("高质量单张").assertDoesNotExist()
        composeRule.onNodeWithText("连续采集").assertDoesNotExist()
        composeRule.onAllNodesWithText("拍摄").assertCountEquals(1)
        composeRule.onNodeWithText("拍后编辑").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("扫码连接电脑").assertIsDisplayed()

        PairingStore(instrumentation.targetContext).clear()
    }

    @Test
    fun editAfterCaptureSelectionSurvivesActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        PairingStore(instrumentation.targetContext).save(
            PairingConfig(
                1,
                "127.0.0.1",
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

        composeRule.onNodeWithText("拍摄").performClick()
        composeRule.onNodeWithContentDescription("拍后编辑开关").assertIsOff()
        composeRule.onNodeWithText("拍后编辑").performClick()
        composeRule.onNodeWithContentDescription("拍后编辑开关").assertIsOn()
        composeRule.activityRule.scenario.recreate()
        composeRule.onNodeWithText("拍摄").performClick()
        composeRule.onNodeWithText("拍下这一页").assertIsDisplayed()
        composeRule.onAllNodesWithText("拍摄").assertCountEquals(1)
        composeRule.onNodeWithText("拍后编辑").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("拍后编辑开关").assertIsOn()

        PairingStore(instrumentation.targetContext).clear()
    }

    @Test
    fun openingNotebooksFromCaptureSelectsTargetAndReturnsToCamera() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        PairingStore(instrumentation.targetContext).clear()
        CaptureRoutingPreferences(instrumentation.targetContext).setPreferWindows(false)
        instrumentation.uiAutomation.executeShellCommand(
            "pm grant com.mathnotes.capture android.permission.CAMERA"
        ).close()
        composeRule.activityRule.scenario.recreate()

        composeRule.onNodeWithText("拍摄").performClick()
        composeRule.onNodeWithContentDescription("选择拍摄目标").performClick()
        composeRule.onNodeWithText("打开 Notebooks…").performClick()

        composeRule.onNodeWithText("选择拍摄目标").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("选择当前 Session 作为拍摄目标").performClick()

        composeRule.onNodeWithText("拍下这一页").assertIsDisplayed()
    }

}
