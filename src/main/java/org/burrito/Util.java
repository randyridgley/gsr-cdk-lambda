package org.burrito;

import com.amazonaws.services.lambda.runtime.Context;
import com.google.gson.Gson;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.burrito.producer.KafkaClickstreamClient;

import java.io.*;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

public class Util {
  private static Random rand = new Random();
  private static final Logger logger = LogManager.getLogger(Util.class);
  private static AtomicInteger counter = new AtomicInteger(0);
  private static long lastGlobalSeqNo = 0L;

  public static void eventWriter(String event, String filesystemLocation, boolean append, String eventType)
      throws IOException {

    String writeEvent = event;
    if (eventType.equalsIgnoreCase("bookmark")) {
      Predicate<Long> globalSeqNoGreaterThan = i -> (i > lastGlobalSeqNo);
      if (globalSeqNoGreaterThan.test(Long.parseLong(event)))
        lastGlobalSeqNo = Long.parseLong(event);
      if (counter.incrementAndGet() == KafkaClickstreamClient.numThreads) {
        writeEvent = Long.toString(lastGlobalSeqNo);
        BufferedWriter eventWriter = new BufferedWriter(new FileWriter(filesystemLocation, append));
        eventWriter.append(writeEvent).append("\n");
        eventWriter.close();
      }
    } else {
      BufferedWriter eventWriter = new BufferedWriter(new FileWriter(filesystemLocation, append));
      eventWriter.append(writeEvent).append("\n");
      eventWriter.close();
    }

  }

  public static void Sleep(Integer sleepRange) {
    try {
      TimeUnit.MILLISECONDS.sleep(rand.nextInt(sleepRange) + 50);
    } catch (InterruptedException e) {
      e.printStackTrace();
    }
  }

  public static void setGlobalSeqNo(String filesystemLocation) throws IOException {
    try {
      BufferedReader br = new BufferedReader(new FileReader(filesystemLocation));
      KafkaClickstreamClient.startingGlobalSeqNo = Long.parseLong(br.readLine());
      KafkaClickstreamClient.counter.set(KafkaClickstreamClient.startingGlobalSeqNo);
      logger.info("Starting Global Seq No: {} \n", KafkaClickstreamClient.startingGlobalSeqNo + 1);
    } catch (FileNotFoundException e) {
      logger.info("Bookmark file not found. Starting from GlobalSeqNo: 0 \n");
    }

  }

  public static void logEnvironment(Object event, Context context, Gson gson) {
    // log execution details
    logger.info("ENVIRONMENT VARIABLES: {} \n", gson.toJson(System.getenv()));
    logger.info("CONTEXT: {} \n", gson.toJson(context));
    // log event details
    logger.info("EVENT: {} \n", gson.toJson(event));
    logger.info("EVENT TYPE: {} \n", event.getClass().toString());
  }

  public static String stackTrace(Throwable e) {
    StringWriter sw = new StringWriter();
    PrintWriter pw = new PrintWriter(sw);
    e.printStackTrace(pw);
    return sw.toString();
  }

  public static long getExpBackoffInterval(int retries, boolean exponentialBackoff) {
    int seed = 23;
    if (exponentialBackoff) {
      return (2 * (Double.valueOf(Math.pow(seed, retries)).longValue())) / 1000;
    } else
      return 1L;
  }
}