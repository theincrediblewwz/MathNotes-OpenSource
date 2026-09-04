package com.mathnotes.capture.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape

private data class MathNotesPalette(
    val background: Color,
    val paper: Color,
    val ink: Color,
    val muted: Color,
    val line: Color,
    val accent: Color,
    val accentSoft: Color,
    val sourceRed: Color,
    val warning: Color,
    val error: Color,
    val success: Color,
    val subtle: Color
)

private val defaultPalette = MathNotesPalette(
    background = Color(0xFFFBF9F7),
    paper = Color(0xFFFCFBF9),
    ink = Color(0xFF232421),
    muted = Color(0xFF7A7B76),
    line = Color(0xFFE8E5DF),
    accent = Color(0xFF237958),
    accentSoft = Color(0xFFEEF3EF),
    sourceRed = Color(0xFF9A4D52),
    warning = Color(0xFFD48B35),
    error = Color(0xFFCF4B48),
    success = Color(0xFF237958),
    subtle = Color(0xFFF3F1ED)
)

private fun paletteFor(themeId: MathNotesThemeId): MathNotesPalette = when (themeId) {
    MathNotesThemeId.DEFAULT_LIGHT -> defaultPalette
    MathNotesThemeId.READING -> defaultPalette.copy(
        background = Color(0xFFF7F6F2), paper = Color(0xFFFCFBF8), ink = Color(0xFF2C2B27),
        muted = Color(0xFF77746D), line = Color(0x142A2B27), accent = Color(0xFF2F7158), accentSoft = Color(0xFFEDF4F0)
    )
    MathNotesThemeId.HIGH_CONTRAST -> defaultPalette.copy(
        background = Color.White, paper = Color.White, ink = Color(0xFF11120F), muted = Color(0xFF51534C),
        line = Color(0x4711120F), accent = Color(0xFF006B45), accentSoft = Color(0xFFDFF5E9), sourceRed = Color(0xFF7F2630)
    )
    MathNotesThemeId.DARK -> defaultPalette.copy(
        background = Color(0xFF171916), paper = Color(0xFF20231F), ink = Color(0xFFF1F1EC), muted = Color(0xFFAAA99F),
        line = Color(0x24F4F4EE), accent = Color(0xFF72C59F), accentSoft = Color(0xFF233D32), sourceRed = Color(0xFFE09CA1),
        subtle = Color(0xFF292C28)
    )
}

internal data class MathNotesSystemBarAppearance(
    val backgroundArgb: Int,
    val useDarkIcons: Boolean
)

internal fun systemBarAppearanceFor(
    themeId: MathNotesThemeId,
    mediaPreviewOpen: Boolean = false
): MathNotesSystemBarAppearance = if (mediaPreviewOpen) {
    MathNotesSystemBarAppearance(0xFF171816.toInt(), false)
} else when (themeId) {
    MathNotesThemeId.DEFAULT_LIGHT -> MathNotesSystemBarAppearance(0xFFFBF9F7.toInt(), true)
    MathNotesThemeId.READING -> MathNotesSystemBarAppearance(0xFFF7F6F2.toInt(), true)
    MathNotesThemeId.HIGH_CONTRAST -> MathNotesSystemBarAppearance(0xFFFFFFFF.toInt(), true)
    MathNotesThemeId.DARK -> MathNotesSystemBarAppearance(0xFF171916.toInt(), false)
}

object MathNotesColors {
    private var palette by mutableStateOf(defaultPalette)

    val Background get() = palette.background
    val Paper get() = palette.paper
    val Ink get() = palette.ink
    val Muted get() = palette.muted
    val Line get() = palette.line
    val Accent get() = palette.accent
    val AccentSoft get() = palette.accentSoft
    val SourceRed get() = palette.sourceRed
    val Warning get() = palette.warning
    val Error get() = palette.error
    val Success get() = palette.success
    val Subtle get() = palette.subtle

    internal fun use(themeId: MathNotesThemeId) {
        val next = paletteFor(themeId)
        if (palette != next) palette = next
    }
}

private fun mathNotesColorScheme(dark: Boolean) = if (dark) darkColorScheme(
    primary = MathNotesColors.Accent, onPrimary = Color(0xFF10251C), primaryContainer = MathNotesColors.AccentSoft,
    onPrimaryContainer = MathNotesColors.Ink, secondary = MathNotesColors.Muted, background = MathNotesColors.Background,
    onBackground = MathNotesColors.Ink, surface = MathNotesColors.Paper, onSurface = MathNotesColors.Ink,
    surfaceVariant = MathNotesColors.Subtle, onSurfaceVariant = MathNotesColors.Muted, outline = MathNotesColors.Muted,
    outlineVariant = MathNotesColors.Line, error = MathNotesColors.Error, onError = Color.White,
    surfaceBright = MathNotesColors.Paper, surfaceDim = MathNotesColors.Background,
    surfaceContainerLowest = MathNotesColors.Paper, surfaceContainerLow = MathNotesColors.Subtle,
    surfaceContainer = MathNotesColors.Subtle, surfaceContainerHigh = MathNotesColors.Subtle,
    surfaceContainerHighest = MathNotesColors.Subtle, surfaceTint = Color.Transparent
) else lightColorScheme(
    primary = MathNotesColors.Accent, onPrimary = Color.White, primaryContainer = MathNotesColors.AccentSoft,
    onPrimaryContainer = Color(0xFF174F41), secondary = MathNotesColors.Muted, onSecondary = Color.White,
    secondaryContainer = MathNotesColors.Subtle, onSecondaryContainer = MathNotesColors.Ink,
    background = MathNotesColors.Background, onBackground = MathNotesColors.Ink, surface = MathNotesColors.Paper,
    onSurface = MathNotesColors.Ink, surfaceVariant = MathNotesColors.Subtle, onSurfaceVariant = MathNotesColors.Muted,
    outline = Color(0xFFD9D6CF), outlineVariant = MathNotesColors.Line, error = MathNotesColors.Error, onError = Color.White,
    surfaceBright = MathNotesColors.Paper, surfaceDim = MathNotesColors.Subtle,
    surfaceContainerLowest = MathNotesColors.Paper, surfaceContainerLow = MathNotesColors.Paper,
    surfaceContainer = MathNotesColors.Paper, surfaceContainerHigh = MathNotesColors.Paper,
    surfaceContainerHighest = MathNotesColors.Subtle, surfaceTint = Color.Transparent
)

private val MathNotesTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 35.sp
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 29.sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 24.sp
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 21.sp
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 19.sp
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp
    )
)

private val MathNotesShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp)
)

@Composable
fun MathNotesTheme(themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT, content: @Composable () -> Unit) {
    MathNotesColors.use(themeId)
    MaterialTheme(
        colorScheme = mathNotesColorScheme(themeId == MathNotesThemeId.DARK),
        typography = MathNotesTypography,
        shapes = MathNotesShapes,
        content = content
    )
}
