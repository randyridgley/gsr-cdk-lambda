package org.burrito.consumer;

import com.amazonaws.services.lambda.runtime.events.KafkaEvent;
import com.amazonaws.services.schemaregistry.deserializers.avro.AWSKafkaAvroDeserializer;
import com.amazonaws.services.schemaregistry.utils.AWSSchemaRegistryConstants;
import com.amazonaws.services.schemaregistry.utils.AvroRecordType;

import org.apache.avro.generic.GenericRecord;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.common.serialization.Deserializer;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.burrito.clickstream.avro.ClickEvent;

import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

class ProcessRecords {

    private static final Logger logger = LogManager.getLogger(ProcessRecords.class);

    private byte[] base64Decode(KafkaEvent.KafkaEventRecord kafkaEventRecord) {
        return Base64.getDecoder().decode(kafkaEventRecord.getValue().getBytes());
    }

    private long getKafkaEventRecordsSize(KafkaEvent kafkaEvent) {
        long size = 0L;
        for (Map.Entry<String, List<KafkaEvent.KafkaEventRecord>> kafkaEventEntry : kafkaEvent.getRecords().entrySet()) {
            size += kafkaEventEntry.getValue().size();
        }
        return size;
    }

    private Map<String, Object> getGSRConfigs() {
        Map<String, Object> gsrConfigs = new HashMap<>();
        gsrConfigs.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, AWSKafkaAvroDeserializer.class.getName());
        gsrConfigs.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, AWSKafkaAvroDeserializer.class.getName());
        gsrConfigs.put(AWSSchemaRegistryConstants.AWS_REGION, System.getenv("AWS_REGION"));
        gsrConfigs.put(AWSSchemaRegistryConstants.AVRO_RECORD_TYPE, AvroRecordType.SPECIFIC_RECORD.getName());
        gsrConfigs.put(AWSSchemaRegistryConstants.REGISTRY_NAME, System.getenv("DEFAULT_SCHEMA_REGISTRY_NAME"));
        return gsrConfigs;
    }

    private void deserializeAddToFirehoseBatch(KafkaEvent kafkaEvent, String requestId, SendKinesisDataFirehose sendKinesisDataFirehose) {
        Deserializer deserializer = new AWSKafkaAvroDeserializer(getGSRConfigs());
        
        kafkaEvent.getRecords().forEach((key, value) -> value.forEach(v -> {
            logger.info("Topic: " + v.getTopic() + " key: " + v.getKey() + " value: " + v.getValue());
            byte[] record = base64Decode(v);
            logger.info("Message:" + Base64.getEncoder().encodeToString(record));
            try {
              ClickEvent clickEvent = (ClickEvent) deserializer.deserialize(v.getTopic(), record);
              sendKinesisDataFirehose.addFirehoseRecordToBatch(clickEvent.toString() + "\n", requestId);
            } catch(Exception ex) {
              logger.error(ex.getMessage());
              GenericRecord rec = (GenericRecord) deserializer.deserialize(v.getTopic(), base64Decode(v));
              logger.info("Record:" + rec.toString());
              sendKinesisDataFirehose.addFirehoseRecordToBatch(rec.toString() + "\n", requestId);
            }
            
        }));
    }

    void processRecords(KafkaEvent kafkaEvent, String requestId) {
        logger.info("Processing batch with {} records for Request ID {} \n", getKafkaEventRecordsSize(kafkaEvent), requestId);
        SendKinesisDataFirehose sendKinesisDataFirehose = new SendKinesisDataFirehose();        
        deserializeAddToFirehoseBatch(kafkaEvent, requestId, sendKinesisDataFirehose);
        SendKinesisDataFirehose.sendFirehoseBatch(sendKinesisDataFirehose.getFirehoseBatch(), 0, requestId, SendKinesisDataFirehose.batchNumber.incrementAndGet());
        SendKinesisDataFirehose.batchNumber.set(0);
    }
}