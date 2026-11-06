package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.Test;

public class SavedImageTest {
    @Test
    public void takesOnlyPictureTypes() {
        assertTrue(SavedImage.isImageType("image/png"));
        assertTrue(SavedImage.isImageType("image/svg+xml"));
        assertFalse(SavedImage.isImageType(null));
        assertFalse(SavedImage.isImageType(""));
        assertFalse(SavedImage.isImageType("application/vnd.android.package-archive"));
        assertFalse(SavedImage.isImageType("image/png; charset=utf-8"));
        assertFalse(SavedImage.isImageType("text/html"));
    }

    @Test
    public void decodesBase64UpToTheLimit() {
        byte[] bytes = { 0, 1, (byte) 255 };
        assertArrayEquals(bytes, SavedImage.decode(Base64.getEncoder().encodeToString(bytes)));
        assertNull(SavedImage.decode(null));
        assertNull(SavedImage.decode(""));
        assertNull(SavedImage.decode("not base64!"));
        assertNull(SavedImage.decode(Base64.getEncoder().encodeToString(new byte[SavedImage.MAX_BYTES + 1])));
    }

    @Test
    public void keepsANameThatCannotLeaveDownloads() {
        assertEquals("shot.png", SavedImage.fileName("shot.png"));
        assertEquals("passwd", SavedImage.fileName("../../etc/passwd"));
        assertEquals("evil.png", SavedImage.fileName("..\\evil.png"));
        assertEquals("hidden.png", SavedImage.fileName(".hidden.png"));
        assertEquals("ab.png", SavedImage.fileName("a\u0000:b?.png"));
        assertEquals("image", SavedImage.fileName(null));
        assertEquals("image", SavedImage.fileName("dir/"));
        assertEquals("image", SavedImage.fileName(".."));
        String cut = SavedImage.fileName("x".repeat(300) + ".jpeg");
        assertEquals(200, cut.length());
        assertTrue(cut.endsWith(".jpeg"));
        // Korean takes 3 bytes a character: the cut counts bytes and never splits one
        String korean = SavedImage.fileName("\uADF8\uB9BC".repeat(80) + ".png");
        assertTrue(korean.getBytes(StandardCharsets.UTF_8).length <= 200);
        assertTrue(korean.endsWith("\uADF8.png") || korean.endsWith("\uB9BC.png"));
    }

    @Test
    public void startsAtMostTenSavesAMinute() {
        SavedImage.Budget budget = new SavedImage.Budget();
        for (int i = 0; i < SavedImage.MAX_PER_MINUTE; i++) assertTrue(budget.take(1_000 + i, 1));
        assertFalse(budget.take(30_000, 1));
        assertTrue(budget.take(61_000, 1));
    }

    @Test
    public void stopsForTheRunOnceItsSavesOrBytesAreSpent() {
        SavedImage.Budget byCount = new SavedImage.Budget();
        for (int i = 0; i < SavedImage.MAX_PER_RUN; i++) assertTrue(byCount.take(i * 60_000L, 1));
        assertFalse(byCount.take(SavedImage.MAX_PER_RUN * 60_000L, 1));
        SavedImage.Budget byBytes = new SavedImage.Budget();
        int big = SavedImage.MAX_BYTES;
        long minute = 0;
        while (byBytes.take(minute, big)) minute += 60_000;
        assertEquals(SavedImage.MAX_BYTES_PER_RUN / big, minute / 60_000);
        assertFalse(byBytes.take(minute + 60_000, 1));
    }
}
