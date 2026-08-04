#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

const char* ssid = "Fruity Vapes F10";
const char* password = "ufone@333";

const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

const char* subscribeTopic = "fruityvapes/VM01/cmd";
const char* statusTopic = "fruityvapes/VM01/status";

// Motor A
#define ENA 33
#define IN1 25
#define IN2 26

// Motor B
#define ENB 32
#define IN3 27
#define IN4 14

WiFiClient espClient;
PubSubClient client(espClient);

void connectWiFi() {
  Serial.println("Connecting to WiFi...");

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}
void dispenseMotor1() {

  Serial.println("Dispensing from A1...");

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  delay(1200);

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
}

void dispenseMotor2() {

  Serial.println("Dispensing from A2...");

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  delay(1200);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}
void callback(char* topic, byte* payload, unsigned int length) {

  Serial.println();
  Serial.println("========== MQTT MESSAGE RECEIVED ==========");

  // Convert payload to String
  String message = "";

  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println(message);

  // Parse JSON
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);

  if (error) {
    Serial.print("JSON Parse Failed: ");
    Serial.println(error.c_str());
    return;
  }

  int orderId = doc["orderId"];
  String slot = doc["slot"].as<String>();
  String action = doc["action"].as<String>();

  Serial.print("Order ID: ");
  Serial.println(orderId);

  Serial.print("Slot: ");
  Serial.println(slot);

  Serial.print("Action: ");
  Serial.println(action);

  if (action == "dispense") {

    if (slot == "A1") {
      dispenseMotor1();
    }
    else if (slot == "A2") {
      dispenseMotor2();
    }
    else {
      Serial.println("Unknown Slot!");
      return;
    }

    // Create status JSON
    StaticJsonDocument<128> response;

    response["orderId"] = orderId;
    response["slot"] = slot;
    response["status"] = "dispensed";

    char buffer[128];
    serializeJson(response, buffer);

    // Publish status back to server
    client.publish(statusTopic, buffer);

    Serial.println("Dispense completed.");
    Serial.println("Status published.");
  }

  Serial.println("===========================================");
}

void reconnectMQTT() {

  while (!client.connected()) {

    Serial.print("Connecting to MQTT...");

    String clientId = "ESP32-";
    clientId += String(random(0xffff), HEX);

    if (client.connect(clientId.c_str())) {

      Serial.println(" Connected!");

      client.subscribe(subscribeTopic);

      Serial.print("Subscribed to: ");
      Serial.println(subscribeTopic);

    } else {

      Serial.print(" Failed, rc=");
      Serial.print(client.state());
      Serial.println(" Retrying in 5 seconds...");

      delay(5000);
    }
  }
}

void setup() {

  Serial.begin(115200);
  pinMode(ENA, OUTPUT);
pinMode(IN1, OUTPUT);
pinMode(IN2, OUTPUT);

pinMode(ENB, OUTPUT);
pinMode(IN3, OUTPUT);
pinMode(IN4, OUTPUT);

analogWrite(ENA, 80);   // Speed: 0–255
analogWrite(ENB, 80);   // Speed: 0–255

  connectWiFi();

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
}

void loop() {

  if (!client.connected()) {
    reconnectMQTT();
  }

  client.loop();
}