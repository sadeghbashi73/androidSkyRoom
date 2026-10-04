package online.skyroom.presenter;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Foreground service that keeps a class alive while the user is in other apps:
 * the microphone keeps working in the background, and while presenting it
 * captures the screen with MediaProjection and hands JPEG frames to the page.
 */
public class ClassService extends Service {

    public static final String ACTION_KEEPALIVE = "keepalive";
    public static final String ACTION_START_PROJECTION = "start_projection";
    public static final String ACTION_STOP_PROJECTION = "stop_projection";
    public static final String ACTION_STOP = "stop";
    public static final String EXTRA_RESULT_CODE = "result_code";
    public static final String EXTRA_RESULT_DATA = "result_data";

    /** Receives capture events on the main thread. */
    public interface ScreenListener {
        void onScreenStart(int width, int height);
        void onScreenFrame(String jpegBase64);
        void onScreenEnd();
        void onScreenError(String message);
    }

    private static final String CHANNEL_ID = "class";
    private static final int NOTIFICATION_ID = 1;
    private static final int MAX_LONG_SIDE = 1280;
    private static final long FRAME_INTERVAL_MS = 100;   // ~10 fps
    private static final long KEYFRAME_INTERVAL_MS = 1000; // resend still screens
    private static final int JPEG_QUALITY = 70;

    private static ScreenListener listener;
    private static boolean sharing;

    public static void setListener(ScreenListener l) { listener = l; }
    public static boolean isSharing() { return sharing; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread captureThread;
    private Handler capture;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private int width, height, dpi;
    private long lastFrameAt;
    private String lastFrame;

    private final Runnable keyframe = new Runnable() {
        @Override public void run() {
            if (projection == null) return;
            if (lastFrame != null && SystemClock.uptimeMillis() - lastFrameAt >= KEYFRAME_INTERVAL_MS) {
                deliverFrame(lastFrame);
            }
            capture.postDelayed(this, KEYFRAME_INTERVAL_MS);
        }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START_PROJECTION.equals(action)) {
            // Android 14+: startForeground(mediaProjection) must precede getMediaProjection().
            goForeground(true);
            startProjection(intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED),
                    intent.getParcelableExtra(EXTRA_RESULT_DATA));
        } else if (ACTION_STOP_PROJECTION.equals(action)) {
            stopProjection();
            goForeground(false);
        } else if (ACTION_STOP.equals(action)) {
            stopProjection();
            stopForeground(true);
            stopSelf();
        } else {
            goForeground(false);
        }
        return START_NOT_STICKY;
    }

    private boolean hasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void goForeground(boolean projecting) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "کلاس در حال اجرا", NotificationManager.IMPORTANCE_LOW));
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_share)
                .setContentTitle(projecting ? "در حال اشتراک صفحه" : "کلاس اسکای‌روم باز است")
                .setContentText(projecting ? "صفحه گوشی برای کلاس ارسال می‌شود" : "میکروفون در پس‌زمینه فعال می‌ماند")
                .setContentIntent(open)
                .setOngoing(true);
        if (projecting) {
            PendingIntent stop = PendingIntent.getService(this, 1,
                    new Intent(this, ClassService.class).setAction(ACTION_STOP_PROJECTION), piFlags);
            b.addAction(new Notification.Action.Builder(null, "توقف اشتراک صفحه", stop).build());
        }

        if (Build.VERSION.SDK_INT >= 29) {
            int type = 0;
            if (projecting) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            if (hasMic()) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (type == 0) {
                // Nothing to protect yet (mic not granted, not sharing).
                stopSelf();
                return;
            }
            try {
                startForeground(NOTIFICATION_ID, b.build(), type);
            } catch (RuntimeException e) {
                // e.g. Android 14 refusing a microphone FGS started from the background.
                if (projecting) postError("اجرای سرویس اشتراک صفحه ممکن نشد");
                stopSelf();
            }
        } else {
            startForeground(NOTIFICATION_ID, b.build());
        }
    }

    private void startProjection(int resultCode, Intent data) {
        stopProjection();
        if (resultCode != Activity.RESULT_OK || data == null) {
            postError("اجازه اشتراک صفحه داده نشد");
            return;
        }
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        try {
            projection = mpm.getMediaProjection(resultCode, data);
        } catch (RuntimeException e) {
            projection = null;
        }
        if (projection == null) {
            postError("شروع اشتراک صفحه ممکن نشد");
            return;
        }

        captureThread = new HandlerThread("screen-capture");
        captureThread.start();
        capture = new Handler(captureThread.getLooper());

        final MediaProjection current = projection;
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() {
                // User revoked from the system UI (status-bar chip, lock screen …).
                main.post(() -> {
                    if (projection != current) return; // already stopped or replaced
                    stopProjection();
                    goForeground(false);
                });
            }
        }, main);

        computeSize();
        reader = newReader();
        try {
            display = projection.createVirtualDisplay("skyroom-share", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, capture);
        } catch (RuntimeException e) {
            stopProjection();
            postError("شروع اشتراک صفحه ممکن نشد");
            return;
        }
        sharing = true;
        final int w = width, h = height;
        main.post(() -> { if (listener != null) listener.onScreenStart(w, h); });
        capture.postDelayed(keyframe, KEYFRAME_INTERVAL_MS);
    }

    private void computeSize() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        int w = m.widthPixels, h = m.heightPixels;
        float scale = Math.min(1f, MAX_LONG_SIDE / (float) Math.max(w, h));
        // Even dimensions keep video encoders happy.
        width = Math.max(2, Math.round(w * scale) & ~1);
        height = Math.max(2, Math.round(h * scale) & ~1);
        dpi = Math.max(1, Math.round(m.densityDpi * scale));
    }

    private ImageReader newReader() {
        ImageReader r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        r.setOnImageAvailableListener(this::onImage, capture);
        return r;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (display == null || capture == null) return;
        // Follow rotation so the shared screen is not letterboxed.
        capture.post(() -> {
            if (display == null) return;
            int oldW = width, oldH = height;
            computeSize();
            if (oldW == width && oldH == height) return;
            ImageReader old = reader;
            reader = newReader();
            display.resize(width, height, dpi);
            display.setSurface(reader.getSurface());
            old.close();
        });
    }

    private void onImage(ImageReader r) {
        Image img = null;
        try {
            img = r.acquireLatestImage();
            if (img == null) return;
            long now = SystemClock.uptimeMillis();
            if (now - lastFrameAt < FRAME_INTERVAL_MS) return;

            Image.Plane plane = img.getPlanes()[0];
            ByteBuffer buf = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowPadding = plane.getRowStride() - pixelStride * img.getWidth();
            Bitmap padded = Bitmap.createBitmap(img.getWidth() + rowPadding / pixelStride,
                    img.getHeight(), Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(buf);
            Bitmap bmp = rowPadding == 0 ? padded
                    : Bitmap.createBitmap(padded, 0, 0, img.getWidth(), img.getHeight());

            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            if (bmp != padded) bmp.recycle();
            padded.recycle();

            lastFrame = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            deliverFrame(lastFrame);
        } catch (RuntimeException ignored) {
            // A frame lost during rotation/teardown is harmless.
        } finally {
            if (img != null) img.close();
        }
    }

    private void deliverFrame(String b64) {
        lastFrameAt = SystemClock.uptimeMillis();
        main.post(() -> { if (listener != null && sharing) listener.onScreenFrame(b64); });
    }

    private void stopProjection() {
        boolean was = sharing;
        sharing = false;
        if (display != null) { display.release(); display = null; }
        if (projection != null) { projection.stop(); projection = null; }
        if (captureThread != null) {
            final ImageReader r = reader;
            capture.removeCallbacksAndMessages(null);
            capture.post(() -> { if (r != null) r.close(); });
            captureThread.quitSafely();
            captureThread = null;
            capture = null;
        } else if (reader != null) {
            reader.close();
        }
        reader = null;
        lastFrame = null;
        if (was) main.post(() -> { if (listener != null) listener.onScreenEnd(); });
    }

    private void postError(String msg) {
        main.post(() -> { if (listener != null) listener.onScreenError(msg); });
    }

    @Override
    public void onDestroy() {
        stopProjection();
        super.onDestroy();
    }
}
