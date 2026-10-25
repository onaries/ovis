package sh.ovis.push;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Shows a PC's push. The relay sends FCM a data message whose "ovis" field is the PC's ciphertext
 * (standard base64); it is decrypted here with this phone's keys and shown as the browser's
 * service worker shows it (public/sw.js): the PC's title and body, one notification per tag. A
 * push that cannot be decrypted still shows, with the relay's fallback line.
 */
public class OvisMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL = "agent-alerts";
    private static final String TAG = "OvisPush";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String title = "Ovis";
        String body = getString(R.string.ovis_push_fallback);
        String tag = "herdr";
        String sealed = message.getData().get("ovis");
        if (sealed != null) {
            try {
                byte[] plain = WebPushDecrypt.decrypt(Base64.getDecoder().decode(sealed), PushStore.read(this));
                JSONObject payload = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                title = payload.optString("title", "").isEmpty() ? title : payload.getString("title");
                body = payload.optString("body", "");
                tag = payload.optString("tag", "").isEmpty() ? tag : payload.getString("tag");
            } catch (GeneralSecurityException | IllegalArgumentException | JSONException e) {
                // keys made again since the PC subscribed, or a damaged body: the fallback line shows
                Log.w(TAG, "a push could not be read: " + e.getClass().getSimpleName());
            }
        }
        show(title, body, tag);
    }

    private void show(String title, String body, String tag) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, getString(R.string.ovis_push_channel), NotificationManager.IMPORTANCE_HIGH)
        );
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ovis)
            .setColor(0xFF2E3A59)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap);
        NotificationManagerCompat.from(this).notify(tag, 0, notification.build());
    }
}
