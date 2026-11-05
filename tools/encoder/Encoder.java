package dsh;

import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.view.Surface;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;

/**
 * Device-side H.264 screen encoder, modelled on scrcpy's ScreenEncoder.
 *
 * Why this exists: the previous stream shelled out to `screenrecord
 * --output-format=h264`, which is a *recorder* with a 180 s default limit and a
 * process restart every 179 s. Holding MediaCodec ourselves removes that limit
 * entirely, and a Surface fed by a virtual display is the same pipeline scrcpy
 * uses, so rotation is handled by recreating the codec instead of tearing down
 * the whole adb pipe.
 *
 * Wire format (deliberately minimal, the host parses it):
 *
 *   header, once:  "DSHV" | u32 version | u32 width | u32 height | u32 avcC length | avcC bytes
 *   per packet:    u8 flags | u32 ptsUs | u32 size | payload
 *
 *   flags bit0 = key frame, bit1 = codec config packet
 *
 * All integers are big-endian. This is not scrcpy's protocol (its framing is
 * versioned and internal); it carries the same information so the host can feed
 * WebCodecs an identical avcC description.
 */
public final class Encoder {
    private static final int WIRE_VERSION = 1;
    private static final byte[] MAGIC = {'D', 'S', 'H', 'V'};

    private static final int FLAG_KEY = 1;
    private static final int FLAG_CONFIG = 2;

    private final BufferedOutputStream out;
    private final int width;
    private final int height;
    private final int bitRate;
    private final int fps;

    private MediaCodec codec;
    private Surface surface;
    private VirtualDisplay display;
    private volatile boolean running = true;

    private Encoder(OutputStream out, int width, int height, int bitRate, int fps) {
        this.out = new BufferedOutputStream(out, 256 * 1024);
        this.width = width;
        this.height = height;
        this.bitRate = bitRate;
        this.fps = fps;
    }

    public static void main(String[] argv) {
        int width = 540;
        int height = 1200;
        int bitRate = 2_500_000;
        int fps = 60;
        for (String arg : argv) {
            int eq = arg.indexOf('=');
            if (eq <= 0) continue;
            String key = arg.substring(0, eq);
            String value = arg.substring(eq + 1);
            try {
                if ("width".equals(key)) width = Integer.parseInt(value);
                else if ("height".equals(key)) height = Integer.parseInt(value);
                else if ("bit_rate".equals(key)) bitRate = Integer.parseInt(value);
                else if ("fps".equals(key)) fps = Integer.parseInt(value);
            } catch (NumberFormatException ignored) {
                // Leave the default: a bad argument must not kill the stream.
            }
        }
        try {
            Encoder encoder = new Encoder(System.out, width, height, bitRate, fps);
            encoder.run();
        } catch (Throwable error) {
            // app_process reports this on stderr, which the host surfaces to the panel.
            System.err.println("DSH_ENCODER_FATAL " + error);
            error.printStackTrace(System.err);
            System.exit(1);
        }
    }

    private void run() throws Exception {
        boolean started = false;
        while (running && !started) {
            try {
                startCodec();
                started = true;
            } catch (Throwable error) {
                // Encoder init can fail transiently (e.g. while the display is
                // turning). Retry instead of dying like screenrecord does.
                System.err.println("DSH_ENCODER_RETRY " + error);
                releaseCodec();
                try { Thread.sleep(400); } catch (InterruptedException ie) { return; }
            }
        }
        if (!started) return;

        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running) {
            int index;
            try {
                index = codec.dequeueOutputBuffer(info, 10_000);
            } catch (IllegalStateException dead) {
                return;
            }
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) continue;
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                sendCodecConfig(codec.getOutputFormat());
                continue;
            }
            if (index < 0) continue;

            try {
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (buffer != null && info.size > 0) {
                    buffer.position(info.offset);
                    buffer.limit(info.offset + info.size);
                    int flags = 0;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) flags |= FLAG_KEY;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) flags |= FLAG_CONFIG;
                    writePacket(flags, info.presentationTimeUs, buffer, info.size);
                }
            } finally {
                codec.releaseOutputBuffer(index, false);
            }
        }
        releaseCodec();
    }

    /** Create the codec, the input surface and the virtual display that feeds it. */
    private void startCodec() throws IOException, ReflectiveOperationException {
        MediaFormat format = MediaFormat.createVideoFormat("video/avc", width, height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Lowest latency mode: encode as soon as a frame arrives.
            format.setInteger(MediaFormat.KEY_LATENCY, 0);
        }

        codec = MediaCodec.createEncoderByType("video/avc");
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        surface = codec.createInputSurface();
        codec.start();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            // Ask the encoder to repeat the previous frame when nothing changes, so a
            // static screen still produces packets (screenrecord's idle-drop symptom).
            Bundle params = new Bundle();
            params.putInt(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
            try { codec.setParameters(params); } catch (Throwable ignored) { }
        }

        // app_process has no Activity/Context, so obtain the system DisplayManager
        // through DisplayManagerGlobal (what Activity.getSystemService returns).
        //
        // The PUBLIC createVirtualDisplay overload would create a *new, blank* display.
        // Mirroring the real screen needs the hidden overload that takes a displayId:
        // SurfaceFlinger then redirects that display's output to our surface. It is not
        // in the public SDK, so it is reached by reflection — the same trick scrcpy uses.
        Class<?> globalClass = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object global = globalClass.getMethod("getInstance").invoke(null);

        java.lang.reflect.Method create = null;
        for (java.lang.reflect.Method m : globalClass.getMethods()) {
            if (!"createVirtualDisplay".equals(m.getName())) continue;
            Class<?>[] p = m.getParameterTypes();
            // (String name, int w, int h, int densityDpi, Surface, int flags,
            //  VirtualDisplay.Callback, Handler, String uniqueId[, int displayId])
            if (p.length < 9 || p.length > 10) continue;
            if (p[0] != String.class || p[4] != Surface.class) continue;
            create = m;
            break;
        }
        if (create == null) throw new IllegalStateException("no mirroring createVirtualDisplay overload");

        int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION;
        Class<?>[] types = create.getParameterTypes();
        Object[] args = new Object[types.length];
        args[0] = "dsh-encoder";
        args[1] = width;
        args[2] = height;
        args[3] = 1;                      // densityDpi
        args[4] = surface;
        args[5] = flags;
        args[6] = null;                   // VirtualDisplay.Callback
        args[7] = null;                   // Handler
        args[8] = null;                   // uniqueId
        if (types.length == 10) args[9] = 0;   // displayId 0 = the physical display

        display = (VirtualDisplay) create.invoke(global, args);
    }

    /** Emit the avcC record once, from the codec's output format. */
    private void sendCodecConfig(MediaFormat format) throws IOException {
        ByteBuffer sps = format.getByteBuffer("csd-0");
        ByteBuffer pps = format.getByteBuffer("csd-1");
        if (sps == null) return;
        byte[] spsBytes = toArray(sps);
        byte[] ppsBytes = pps == null ? new byte[0] : toArray(pps);

        // The codec hands out Annex-B (00 00 00 01 prefixed) parameter sets; avcC wants
        // the NAL payload without the start code.
        int spsOff = startCodeLength(spsBytes);
        int ppsOff = ppsBytes.length == 0 ? 0 : startCodeLength(ppsBytes);

        int len = 11 + (spsBytes.length - spsOff) + (ppsBytes.length - ppsOff);
        byte[] avcC = new byte[len];
        int o = 0;
        avcC[o++] = 1;                                        // configurationVersion
        avcC[o++] = spsBytes[spsOff + 1];                     // AVCProfileIndication
        avcC[o++] = spsBytes[spsOff + 2];                     // profile_compatibility
        avcC[o++] = spsBytes[spsOff + 3];                     // AVCLevelIndication
        avcC[o++] = (byte) 0xfc | 3;                          // lengthSizeMinusOne = 3
        avcC[o++] = (byte) 0xe0 | 1;                          // numOfSequenceParameterSets
        int spsLen = spsBytes.length - spsOff;
        avcC[o++] = (byte) (spsLen >> 8);
        avcC[o++] = (byte) spsLen;
        System.arraycopy(spsBytes, spsOff, avcC, o, spsLen);
        o += spsLen;
        int ppsLen = ppsBytes.length - ppsOff;
        avcC[o++] = 1;                                        // numOfPictureParameterSets
        avcC[o++] = (byte) (ppsLen >> 8);
        avcC[o++] = (byte) ppsLen;
        if (ppsLen > 0) System.arraycopy(ppsBytes, ppsOff, avcC, o, ppsLen);

        writeHeader(avcC);
    }

    private void writeHeader(byte[] avcC) throws IOException {
        out.write(MAGIC);
        writeInt(WIRE_VERSION);
        writeInt(width);
        writeInt(height);
        writeInt(avcC.length);
        out.write(avcC);
        out.flush();
    }

    private void writePacket(int flags, long ptsUs, ByteBuffer payload, int size) throws IOException {
        out.write(flags);
        writeInt((int) (ptsUs / 1000));   // microseconds of PTS exceed u32; the host only needs ordering
        writeInt(size);
        byte[] chunk = new byte[size];
        payload.get(chunk, 0, size);
        out.write(chunk);
        out.flush();
    }

    private void writeInt(int value) throws IOException {
        out.write((value >>> 24) & 0xff);
        out.write((value >>> 16) & 0xff);
        out.write((value >>> 8) & 0xff);
        out.write(value & 0xff);
    }

    private static int startCodeLength(byte[] data) {
        if (data.length >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1) return 4;
        if (data.length >= 3 && data[0] == 0 && data[1] == 0 && data[2] == 1) return 3;
        return 0;
    }

    private static byte[] toArray(ByteBuffer buffer) {
        ByteBuffer copy = buffer.duplicate();
        copy.rewind();
        byte[] out = new byte[copy.remaining()];
        copy.get(out);
        return out;
    }

    private void releaseCodec() {
        if (display != null) { try { display.release(); } catch (Throwable ignored) { } display = null; }
        if (surface != null) { try { surface.release(); } catch (Throwable ignored) { } surface = null; }
        if (codec != null) {
            try { codec.stop(); } catch (Throwable ignored) { }
            try { codec.release(); } catch (Throwable ignored) { }
            codec = null;
        }
    }
}
