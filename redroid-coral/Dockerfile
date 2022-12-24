FROM alpine AS download-apk

ARG CORAL_APK_URL
ARG CORAL_APK_HASH_SHA256

RUN apk add curl perl-utils unzip
RUN curl -v -L -o /coral.apk "${CORAL_APK_URL}"
RUN echo "${CORAL_APK_HASH_SHA256}  /coral.apk" | shasum -a 256 -c -
RUN unzip -d /apk -o /coral.apk 'lib/*'

FROM alpine AS download-frida

ARG FRIDA_SERVER_URL=https://github.com/frida/frida/releases/download/16.0.7/frida-server-16.0.7-android-x86_64.xz

RUN apk add curl xz
RUN curl -v -L -o /frida-server.xz "${FRIDA_SERVER_URL}"
RUN xz --decompress -k /frida-server.xz
RUN chmod +x /frida-server

FROM redroid/redroid:11.0.0-latest

RUN --mount=from=redroid/redroid:11.0.0-latest,source=/system/apex,target=/apex mv /system/xbin/su /system/xbin/_su

COPY --from=download-apk /coral.apk /system/app/Coral/Coral.apk
COPY --from=download-apk /apk/lib/x86 /system/lib
COPY --from=download-apk /apk/lib/x86_64 /system/lib64
COPY --from=download-frida /frida-server /system/bin/frida-server

CMD [ "ro.secure=0" ]
