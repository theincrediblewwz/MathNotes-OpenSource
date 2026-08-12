package com.mathnotes.capture.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun MathNotesPageHeader(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    eyebrow: String? = null
) {
    Column(modifier) {
        if (eyebrow != null) {
            Text(
                eyebrow.uppercase(),
                style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                color = MathNotesColors.Muted
            )
            Spacer(Modifier.height(5.dp))
        }
        Text(
            title,
            style = androidx.compose.material3.MaterialTheme.typography.headlineLarge,
            color = MathNotesColors.Ink
        )
        Spacer(Modifier.height(7.dp))
        Text(
            detail,
            style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
            color = MathNotesColors.Muted
        )
    }
}

@Composable
fun MathNotesPaper(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = MathNotesColors.Paper,
        border = BorderStroke(1.dp, MathNotesColors.Line),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

@Composable
fun MathNotesPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    @DrawableRes icon: Int? = null
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(52.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = MathNotesColors.Accent,
            contentColor = Color.White,
            disabledContainerColor = MathNotesColors.AccentSoft,
            disabledContentColor = Color(0xFF356851)
        ),
        elevation = ButtonDefaults.buttonElevation(0.dp, 0.dp, 0.dp, 0.dp, 0.dp)
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
        }
        Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun MathNotesSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    selected: Boolean = false
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(46.dp).semantics { this.selected = selected },
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(if (selected) 1.5.dp else 1.dp, if (selected) MathNotesColors.Accent else MathNotesColors.Line),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = if (selected) MathNotesColors.AccentSoft else Color.Transparent,
            contentColor = if (selected) MathNotesColors.Accent else MathNotesColors.Ink,
            disabledContentColor = MathNotesColors.Muted
        )
    ) {
        Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun MathNotesStatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(10.dp).background(color, CircleShape))
}

data class MathNotesNavItem(
    val key: String,
    val label: String,
    @DrawableRes val icon: Int
)

@Composable
fun MathNotesFloatingNavigation(
    items: List<MathNotesNavItem>,
    selectedKey: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier
            .navigationBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .fillMaxWidth()
            .shadow(10.dp, RoundedCornerShape(16.dp), ambientColor = Color(0x221F201D), spotColor = Color(0x221F201D)),
        shape = RoundedCornerShape(16.dp),
        color = MathNotesColors.Paper.copy(alpha = 0.97f),
        border = BorderStroke(1.dp, MathNotesColors.Line)
    ) {
        Row(Modifier.padding(6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            items.forEach { item ->
                MathNotesNavigationItem(
                    item = item,
                    selected = item.key == selectedKey,
                    onClick = { onSelect(item.key) }
                )
            }
        }
    }
}

@Composable
private fun RowScope.MathNotesNavigationItem(
    item: MathNotesNavItem,
    selected: Boolean,
    onClick: () -> Unit
) {
    val itemShape = RoundedCornerShape(11.dp)
    Column(
        modifier = Modifier
            .weight(1f)
            .height(58.dp)
            .semantics { this.selected = selected }
            .clip(itemShape)
            .background(if (selected) MathNotesColors.AccentSoft else Color.Transparent, itemShape)
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(vertical = 7.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        Icon(
            painterResource(item.icon),
            contentDescription = item.label,
            tint = if (selected) MathNotesColors.Accent else MathNotesColors.Muted,
            modifier = Modifier.size(21.dp)
        )
        Text(
            item.label,
            style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
            color = if (selected) MathNotesColors.Accent else MathNotesColors.Muted,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium
        )
    }
}

@Composable
fun MathNotesFloatingIconButton(
    @DrawableRes icon: Int,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    dark: Boolean = false
) {
    Surface(
        modifier = modifier.shadow(8.dp, RoundedCornerShape(14.dp), ambientColor = Color(0x331F201D), spotColor = Color(0x331F201D)),
        shape = RoundedCornerShape(14.dp),
        color = if (dark) Color(0xE6242424) else MathNotesColors.Paper.copy(alpha = 0.9f),
        border = BorderStroke(1.dp, if (dark) Color.White.copy(alpha = 0.12f) else MathNotesColors.Line)
    ) {
        IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
            Icon(
                painterResource(icon),
                contentDescription = contentDescription,
                tint = if (dark) Color.White else MathNotesColors.Ink,
                modifier = Modifier.size(21.dp)
            )
        }
    }
}
